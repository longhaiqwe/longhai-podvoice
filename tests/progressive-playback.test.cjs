const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');
function setup() {
  const requests = [];
  const code = esbuild.transformSync(fs.readFileSync('main.ts', 'utf8') +
    '\nmodule.exports.Queue = typeof BufferedPcmPlayback === "undefined" ? undefined : BufferedPcmPlayback;\nmodule.exports.merge = combineAudioResults;',
    { loader: 'ts', format: 'cjs', target: 'es2018' }).code;
  class MarkdownView {}
  const ctx = { module: { exports: {} }, console, window: { setTimeout, setInterval: () => 1, clearInterval() {} },
    require: () => ({ Plugin: class {}, Modal: class {}, PluginSettingTab: class {},
      Notice: class {}, MarkdownView, setIcon() {},
      requestUrl: async opts => { requests.push(opts); return { headers: { 'content-type': 'audio/wav' }, arrayBuffer: wav().data }; } }) };
  vm.runInNewContext(code, ctx);
  const p = new ctx.module.exports.default();
  p.loadData = async () => ({ provider: 'gptsovits' });
  return { p, requests, ctx, MarkdownView, ...ctx.module.exports };
}
function wav() {
  const b = Buffer.alloc(44 + 640);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(32000, 24); b.writeUInt32LE(64000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(640, 40); b.fill(64, 44);
  return { data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), extension: 'wav', mimeType: 'audio/wav' };
}
test('each local request selects its explicit model pair without force-loading endpoints', async () => {
  const h = setup(); await h.p.loadSettings();
  await h.p.requestGptSoVitsAudio('第一句。');
  await h.p.requestGptSoVitsAudio('第二句。');
  assert.equal(h.requests.length, 2);
  for (const req of h.requests) {
    assert.equal(req.method, 'POST'); assert.ok(req.url.endsWith('/tts'));
    const body = JSON.parse(req.body);
    assert.equal(body.gpt_weights_path, 'GPT_weights_v2/liufei-e15.ckpt');
    assert.equal(body.sovits_weights_path, 'SoVITS_weights_v2/liufei_clean_20260930_e2_s160.pth');
    assert.equal(body.batch_size, 2); assert.equal(body.streaming_mode, false); assert.equal(body.mastering, true);
  }
});
test('first chunk is delivered before second inference; saved WAV stays byte identical', async () => {
  const h = setup(); await h.p.loadSettings();
  h.p.getGenerationChunks = () => ['第一段。', '第二段。'];
  const events = [], a = wav();
  h.p.requestGptSoVitsAudio = async text => { events.push(text); return a; };
  const result = await h.p.generateWithGptSoVitsChunks('正文', 10, undefined,
    (audio, index, count) => { assert.equal(audio, a); assert.equal(count, 2); events.push(`ready${index}`); });
  assert.deepEqual(events, ['第一段。', 'ready0', '第二段。', 'ready1']);
  assert.deepEqual(new Uint8Array(result.data), new Uint8Array(h.merge([a, a], 'GPT-SoVITS', .5).data));
});
test('voice and sampling settings stay fixed while settings are edited between chunks', async () => {
  const h = setup(); await h.p.loadSettings();
  h.p.settings.chunkCharacters = 2;
  h.p.getGenerationChunks = () => ['一。', '二。'];
  await h.p.generateWithGptSoVits('一。二。', undefined, () => {
    h.p.settings.gptsovitsVoicePreset = 'mengyan_acoustic_candidate';
    h.p.settings.gptsovitsTemperature = .1;
  });
  const payloads = h.requests.filter(r => r.method === 'POST').map(r => JSON.parse(r.body));
  assert.equal(payloads.length, 2);
  assert.equal(h.p.settings.gptsovitsTemperature, .1, 'chunk callback must actually run');
  assert.equal(payloads[0].gpt_weights_path, payloads[1].gpt_weights_path);
  assert.equal(payloads[0].temperature, payloads[1].temperature);
});
function audioContext() {
  return { currentTime: 0, destination: {}, sources: [],
    resume: async () => {}, close: async () => {},
    createBufferSource() {
      const source = { playbackRate: { value: 1 }, connect() {}, disconnect() {},
        start(when, offset) { this.when = when; this.offset = offset; }, stop() { this.stopped = true; } };
      this.sources.push(source); return source;
    } };
}
test('buffered playback schedules original audio with exactly half-second gaps', async () => {
  const { Queue } = setup(); assert.equal(typeof Queue, 'function');
  const ctx = audioContext(), q = new Queue(ctx);
  q.append({ duration: 10 }); await q.play();
  ctx.currentTime = 2; q.append({ duration: 5 });
  assert.equal(ctx.sources[0].when, 0); assert.equal(ctx.sources[0].stopped, undefined);
  assert.equal(ctx.sources[1].when, 10.5); assert.equal(q.duration, 15.5);
});
test('underrun waits for next audio; manual pause prevents automatic resumption', async () => {
  const { Queue } = setup(); assert.equal(typeof Queue, 'function');
  const ctx = audioContext(), q = new Queue(ctx);
  q.append({ duration: 3 }); await q.play(); ctx.currentTime = 20;
  q.append({ duration: 4 });
  assert.equal(ctx.sources.at(-1).when, 20.5); assert.equal(q.position, 3);
  q.pause(); const count = ctx.sources.length; q.append({ duration: 2 });
  assert.equal(ctx.sources.length, count); assert.equal(q.isPlaying, false);
  await q.play(); assert.equal(q.isPlaying, true);
});
test('pause during resume and destruction cannot resurrect playback', async () => {
  const { Queue } = setup(); assert.equal(typeof Queue, 'function');
  const ctx = audioContext(), q = new Queue(ctx); let resume;
  ctx.resume = () => new Promise(resolve => { resume = resolve; });
  q.append({ duration: 3 }); const pending = q.play(); q.pause(); resume(); await pending;
  assert.equal(ctx.sources.length, 0);
  q.destroy(); q.append({ duration: 3 }); await q.play();
  assert.equal(ctx.sources.length, 0);
});
test('seeking preserves position and resumes without skipping the boundary silence', async () => {
  const { Queue } = setup(); assert.equal(typeof Queue, 'function');
  const ctx = audioContext(), q = new Queue(ctx);
  q.append({ duration: 10 }); q.append({ duration: 5 });
  q.seek(8); await q.play();
  assert.equal(ctx.sources[0].offset, 8); assert.equal(ctx.sources[1].when, 2.5);
  ctx.currentTime = 2; assert.equal(q.position, 10);
  q.pause(); ctx.currentTime = 50; assert.equal(q.position, 10);
});

test('both built-in voices and custom voice preserve synthesis settings and add acoustic sentence isolation', async () => {
  const original = require('./fixtures/gptsovits-original-payloads.json');
  for (const voice of ['liufei_acoustic_candidate', 'mengyan_acoustic_candidate', 'custom']) {
    const next = setup();
    await next.p.loadSettings(); next.p.settings.gptsovitsVoicePreset = voice;
    await next.p.requestGptSoVitsAudio('会议从十点半开始。这是保持声音不变的测试。');
    const { independent_decode, ...payload } = JSON.parse(next.requests.at(-1).body);
    assert.equal(independent_decode, true);
    assert.deepEqual(payload, original[voice]);
  }
});

class Element {
  constructor(options = {}) { this.textContent = options.text || ''; this.children = []; }
  createEl(_tag, options) { const el = new Element(options); this.children.push(el); return el; }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  remove() { this.removed = true; }
  setCssStyles() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  addClass() {}
  removeClass() {}
  toggleClass() {}
  empty() { this.children = []; }

}
async function pipeline() {
  const h = setup(); await h.p.loadSettings();
  h.ctx.document = { body: new Element(), querySelectorAll: () => [] };
  h.ctx.AudioContext = class {
    constructor() { return { ...audioContext(), decodeAudioData: async () => ({ duration: .01 }) }; }
  };
  h.ctx.Audio = class {
    constructor() { this.paused = true; this.duration = 20; this.currentTime = 0; this.readyState = 0; this.listeners = {}; }
    addEventListener(e, fn) { (this.listeners[e] ||= []).push(fn); }
    removeEventListener() {}
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  };
  h.ctx.cancelAnimationFrame = () => {};
  h.ctx.requestAnimationFrame = () => 1;
  h.p.settings.enableSpeechAlignment = false;
  h.view = new h.MarkdownView();
  h.view.contentEl = new Element(); h.view.containerEl = new Element();
  h.p.app = { workspace: { getActiveFile: () => h.view.file, getLeavesOfType: () => [{ view: h.view }] }, vault: { read: async () => '正文。', getResourcePath: f => f.path } };
  h.p.refreshAllInlineButtonsDebounced = () => {};
  h.p.settings.chunkCharacters = 2;
  h.p.getGenerationChunks = () => ['一。', '二。'];
  h.p.runLoggedGeneration = async (_text, _mode, _file, request) => ({ value: await request({}), durationMs: 1 });
  h.saved = 0;
  h.p.saveAudioFile = async () => { h.saved++; return { path: 'test.wav' }; };
  h.file = { path: 'test.md', basename: 'test' }; h.view.file = h.file;
  return h;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('production 1200 setting sends natural paragraphs separately even for a short article', async () => {
  const h = setup(); await h.p.loadSettings();
  const paragraphs = ['第一段已经可以朗读，不需要等待后面的段落。', '第二段继续在后台生成。', '第三段最后合并保存。'];
  const events = [];
  h.p.requestGptSoVitsAudio = async text => { events.push(text); return wav(); };
  await h.p.generateWithGptSoVits(paragraphs.join('\n\n'), undefined, (_audio, i) => events.push(`ready${i}`));
  assert.deepEqual(events, paragraphs.flatMap((p, i) => [p, `ready${i}`]));
  const log = h.p.createGenerationLog(paragraphs.join('\n\n'), 'note');
  assert.equal(log.chunkCount, 3);
  assert.equal(h.p.settings.chunkCharacters, 1200, 'do not overwrite the saved setting');
});
test('long paragraphs start small and never combine with another paragraph', async () => {
  const h = setup(); await h.p.loadSettings();
  const sentence = '这是一个需要保留完整边界的句子，我们希望听到自然的声音，而不是等到很多段都生成完才播放。';
  const text = sentence.repeat(12) + '\n\n下一段单独生成。\n最后一段也单独生成。';
  const chunks = h.p.getGenerationChunks(text, 1200, 'gptsovits');
  assert.ok(chunks[0].length <= 80, `first chunk is ${chunks[0].length} chars`);
  assert.ok(chunks.slice(1).every(s => s.length <= 160));
  assert.deepEqual(Array.from(chunks.slice(-2)), ['下一段单独生成。', '最后一段也单独生成。']);
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.ok(chunks.every(s => /[。！？!?][”’"）)]*$/.test(s)));
});
test('chunk boundaries retain closing quotes, decimal numbers, times and English words', async () => {
  const h = setup(); await h.p.loadSettings();
  const quote = '他说：“' + '我们保留这句话的边界'.repeat(4) + '。”';
  const text = quote.repeat(3) + '\n今天讨论3.14159和1,234.56，以及10:30和01:10:30。\n' + 'uninterrupted'.repeat(30);
  const chunks = h.p.getGenerationChunks(text, 1200, 'gptsovits');
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.ok(chunks.filter(s => s.startsWith('他说')).every(s => s.endsWith('。”')));
  for (const token of ['3.14159', '1,234.56', '10:30', '01:10:30', 'uninterrupted'.repeat(30)]) {
    assert.ok(chunks.some(s => s.includes(token)), token);
  }
});
test('paragraph policy is local only and explicit zero still disables chunking', async () => {
  const h = setup(); await h.p.loadSettings(); const text = '第一段。\n\n第二段。';
  for (const provider of ['volcengine', 'minimax', 'replicate', 'custom']) {
    assert.deepEqual(Array.from(h.p.getGenerationChunks(text, 1200, provider)), [text]);
  }
  assert.deepEqual(Array.from(h.p.getGenerationChunks(text, 0, 'gptsovits')), [text]);
});
test('quoted English sentences keep the quote with the ending sentence', async () => {
  const h = setup(); await h.p.loadSettings();
  const sentence = 'She said, "Keep every spoken sentence intact while the rest is loading." ';
  const chunks = h.p.getGenerationChunks(sentence.repeat(8), 1200, 'gptsovits');
  assert.ok(chunks[0].length <= 80);
  assert.ok(chunks.every(s => s.endsWith('."')));
});
test('interactive pipeline plays the first chunk before save, closes without reopening, then saves once', async () => {
  const h = await pipeline(); let finish;
  h.p.requestGptSoVitsAudio = async text => text === '一。' ? wav() : new Promise(resolve => { finish = resolve; });
  const pending = h.p.generateAndSaveAudio('一。二。', h.file, 'note');
  await flush();
  const player = h.p.earlyPlayer;
  assert.ok(player); assert.equal(player.received, 1); assert.equal(h.saved, 0);
  assert.equal(player.queue.isPlaying, true);
  player.destroy(); finish(wav());
  const result = await pending; await flush();
  assert.equal(h.saved, 1); assert.equal(result.earlyPlayback, true);
  assert.equal(h.ctx.document.body.children.length, 0); assert.equal(h.view.contentEl.children.length, 1); assert.equal(player.closed, true);
});
test('second-chunk failure leaves previous full audio untouched and marks preview incomplete', async () => {
  const h = await pipeline();
  h.p.requestGptSoVitsAudio = async text => { if (text === '二。') throw Error('inference failed'); return wav(); };
  await assert.rejects(h.p.generateAndSaveAudio('一。二。', h.file, 'note'), /inference failed/);
  await flush(); assert.equal(h.saved, 0); assert.equal(h.p.earlyPlayer.failed, true);
  assert.equal(h.p.earlyPlayer.saved, undefined);
  h.p.earlyPlayer.destroy();
});
test('finishing generation does not restart manually paused playback', async () => {
  const h = await pipeline(); let finish;
  h.p.requestGptSoVitsAudio = async text => text === '一。' ? wav() : new Promise(resolve => { finish = resolve; });
  const pending = h.p.generateAndSaveAudio('一。二。', h.file, 'selection'); await flush();
  h.p.earlyPlayer.toggle(); finish(wav()); await pending; await flush();
  assert.equal(h.p.earlyPlayer.queue.isPlaying, false);
  assert.equal(h.p.earlyPlayer.saved.path, 'test.wav'); h.p.earlyPlayer.destroy();
});
test('batch generation and unloading never open a progressive player', async () => {
  for (const mode of ['batch', 'note']) {
    const h = await pipeline(); h.p.unloading = mode === 'note';
    h.p.requestGptSoVitsAudio = async () => wav();
    const result = await h.p.generateAndSaveAudio('一。二。', h.file, mode);
    assert.equal(h.ctx.document.body.children.length, 0); assert.equal(result.earlyPlayback, false);
  }
});

test('progressive completion keeps the same floating shell and restores position without restarting a pause', async () => {
  const h = await pipeline(); let finish;
  h.p.requestGptSoVitsAudio = async text => text === '一。' ? wav() : new Promise(resolve => { finish = resolve; });
  const pending = h.p.generateAndSaveAudio('一。二。', h.file, 'note'); await flush();
  const shell = h.p.activeFloatingPlayer, element = shell.containerEl;
  h.p.earlyPlayer.seek(.005); h.p.earlyPlayer.toggle();
  finish(wav()); await pending; await flush();
  assert.equal(h.p.activeFloatingPlayer, shell); assert.equal(shell.containerEl, element);
  shell.audio.listeners.loadedmetadata.forEach(fn => fn());
  assert.equal(shell.audio.currentTime, .005); assert.equal(shell.audio.paused, true);
  assert.equal(shell.audioFile.path, 'test.wav'); assert.equal(shell.speedBtn.disabled, false);
  assert.equal(h.ctx.document.body.children.length, 0); shell.destroy();
});
test('playing handoff resumes the complete file at the buffered position', async () => {
  const h = await pipeline(); let finish;
  h.p.requestGptSoVitsAudio = async text => text === '一。' ? wav() : new Promise(resolve => { finish = resolve; });
  const pending = h.p.generateAndSaveAudio('一。二。', h.file, 'note'); await flush();
  const shell = h.p.activeFloatingPlayer;
  h.p.earlyPlayer.seek(.005); await flush();
  finish(wav()); await pending; await flush();
  shell.audio.listeners.loadedmetadata.forEach(fn => fn());
  assert.equal(shell.audio.currentTime, .005); assert.equal(shell.audio.paused, false);
  shell.destroy();
});


test('background note chunks do not replace the active progressive player', async () => {
  const h = await pipeline();
  const p = h.p;
  const callbacks = [];
  p.generateAudio = (text, status, file, log, onChunk) => new Promise(resolve => callbacks.push({ file, onChunk, resolve }));
  const one = p.generateAndSaveAudio('第一篇', h.view.file, 'note');
  await new Promise(resolve => setImmediate(resolve));
  callbacks[0].onChunk(wav(), 0, 2);
  const player = p.earlyPlayer;
  const other = { path: 'other.md', basename: 'other' };
  const two = p.generateAndSaveAudio('第二篇', other, 'note');
  await new Promise(resolve => setImmediate(resolve));
  callbacks[1].onChunk(wav(), 0, 2);
  assert.equal(p.earlyPlayer, player);
  h.p.app.workspace.getActiveFile = () => other;
  callbacks[0].onChunk(wav(), 1, 2);
  callbacks[1].onChunk(wav(), 1, 2);
  assert.equal(p.earlyPlayer, player, '不得从第二段开始创建缺少开头的播放器');
  await flush();
  assert.equal(player.duration, .52, '切换页面后已有播放器仍应收到后续段落');
  callbacks[0].resolve(wav()); callbacks[1].resolve(wav());
  await Promise.all([one, two]);
});
