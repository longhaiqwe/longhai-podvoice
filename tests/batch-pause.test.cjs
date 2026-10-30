const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { randomUUID } = require('node:crypto');
class Element {
  constructor(text = '') { this.text = text; this.children = []; }
  createEl(tag, options = {}) { const el = new Element(options.text); this.children.push(el); return el; }
  createDiv(options) { return this.createEl('div', options); }
  empty() { this.children = []; }
  addClass() {} removeClass() {} setText(text) { this.text = text; }
  allText() { return [this.text, ...this.children.map(c => c.allText())].join('\n'); }
}
class TFile {
  constructor(path) { this.path = path; this.basename = path.split('/').pop().replace(/\.[^.]+$/, ''); this.extension = path.split('.').pop(); }
}
class TFolder { constructor(path, children = []) { this.path = path; this.name = path; this.children = children; } }
class Modal {
  constructor(app) { this.app = app; this.contentEl = new Element(); }
  open() { this.onOpen?.(); } close() {}
}
const code = esbuild.transformSync(fs.readFileSync('main.ts', 'utf8') + '\nglobalThis.LogModal = GenerationLogsModal;', {
  loader: 'ts', format: 'cjs', target: 'es2018',
}).code;
const clone = v => JSON.parse(JSON.stringify(v));
async function setup(settings = {}, disk = new Map()) {
  let time = 0;
  const notices = [];
  const folders = new Set(['']);
  const files = new Map();
  const writes = [];
  const context = { module: { exports: {} }, console: { log() {}, warn() {}, error() {} },
    performance: { now: () => time }, crypto: { randomUUID },
    window: { setTimeout, clearTimeout, setInterval, clearInterval },
    require: () => ({ Plugin: class {}, Modal, TFile, TFolder, PluginSettingTab: class {},
      Notice: class { constructor(msg) { notices.push(msg); } },
      requestUrl: options => context.request(options),
    }),
  };
  vm.runInNewContext(code, context);
  const p = new context.module.exports.default();
  p.loadData = async () => settings;
  p.saveData = async data => { p.saved = clone(data); };
  await p.loadSettings();
  p.app = { metadataCache: { getFileCache: () => null }, vault: {
    getAbstractFileByPath: path => files.get(path) || (folders.has(path) ? new TFolder(path) : null),
    createFolder: async path => { assert.ok(!folders.has(path), 'concurrent folder creation'); folders.add(path); },
    read: async () => '测试正文',
    adapter: {
      write: async (path, content) => { writes.push(JSON.parse(content)); disk.set(path, content); },
      read: async path => disk.get(path),
      exists: async path => path === 'TTS Logs' ? disk.size > 0 : disk.has(path),
      list: async path => path === 'TTS Logs'
        ? { folders: [...new Set([...disk.keys()].map(p => p.split('/').slice(0, 2).join('/')))], files: [] }
        : { folders: [], files: [...disk.keys()].filter(p => p.startsWith(path + '/')) },
    },
  } };
  p.refreshAllInlineButtons = () => {};
  p.updateStatusBar = () => {};
  p.saveAudioFile = async file => { time += 500; return new TFile(`Audio/${file.basename}.mp3`); };
  const audio = { data: new Uint8Array([0xff, 0xfb, 0x90, 0]).buffer, extension: 'mp3', mimeType: 'audio/mpeg' };
  context.request = async () => ({ json: { status: 'processing' } });
  return { p, notices, writes, disk, files, context, audio,
    tick: ms => { time += ms; }, logs: () => [...disk.values()].map(JSON.parse) };
}

const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await turn(); }
  assert.fail('状态没有按预期推进');
}

test('paused batch releases menu, manual generation runs, resume waits and retains original voice', async () => {
  const h = await setup({ provider: 'gptsovits', includeTitleInAudio: false });
  const p = h.p;
  assert.equal(typeof p.pauseBatchGeneration, 'function', '缺少批量暂停接口');
  p.app.vault.read = async file => file.path === 'batch.md' ? '批量第一段。\n批量第二段。' : '手动正文。';
  const requests = [];
  p.requestGptSoVitsAudio = (text, status, settings) => new Promise(resolve => requests.push({ text, voice: settings.gptsovitsVoicePreset, finish: () => resolve(h.audio) }));
  p.isBatchSyncing = true;
  const batch = p.synthesizeFileQuiet(new TFile('batch.md'));
  await until(() => requests.length === 1);
  await p.pauseBatchGeneration(Date.now() + 60000);
  assert.equal(p.isVoiceSwitchBusy(), false, '当前小段执行期间允许为新任务切换音色');
  requests[0].finish();
  await until(() => p.batchPaused);
  assert.equal(p.isVoiceSwitchBusy(), false);
  assert.equal(p.activeSynthesizingPaths.size, 0);
  await p.selectMenuVoice('gptsovits', 'gptsovitsVoicePreset', 'mengyan_acoustic_candidate');
  assert.equal(p.settings.gptsovitsVoicePreset, 'mengyan_acoustic_candidate');
  const manual = p.synthesizeFile(new TFile('manual.md'));
  await until(() => requests.length === 2);
  await p.resumeBatchGeneration();
  await turn();
  assert.equal(requests.length, 2, '恢复批量必须等待手动任务');
  assert.equal(requests[1].voice, 'mengyan_acoustic_candidate');
  requests[1].finish(); await manual;
  await until(() => requests.length === 3);
  assert.equal(requests[2].voice, 'liufei_acoustic_candidate', '同篇剩余小段必须保留原音色');
  requests[2].finish(); await batch;
  p.isBatchSyncing = false;
  assert.equal(p.isVoiceSwitchBusy(), false);
  assert.equal(p.activeAudioRequests, 0);
  assert.equal(p.activeGenerationIds.size, 0);
});

test('manual success on suspended note prevents old batch audio from overwriting it', async () => {
  const h = await setup({ provider: 'gptsovits', includeTitleInAudio: false }); const p = h.p;
  assert.equal(typeof p.pauseBatchGeneration, 'function');
  let first;
  p.app.vault.read = async () => '第一段。\n第二段。';
  p.requestGptSoVitsAudio = () => new Promise(resolve => { first = resolve; });
  const batch = p.synthesizeFileQuiet(new TFile('same.md'));
  const outcome = batch.catch(e => e);
  await until(() => first);
  await p.pauseBatchGeneration(); first(h.audio);
  await until(() => p.batchPaused);
  const saves = [];
  p.saveAudioFile = async file => { saves.push(file.path); return new TFile('Audio/same.wav'); };
  p.app.vault.read = async () => '手动新正文。';
  p.requestGptSoVitsAudio = async () => h.audio;
  await p.synthesizeFile(new TFile('same.md'));
  await p.resumeBatchGeneration();
  const result = await outcome;
  assert.equal(result.name, 'BatchSupersededError');
  assert.deepEqual(saves, ['same.md']);
  assert.equal(p.activeAudioRequests, 0);
});

test('manual entry points overlap, failures release only their own task', async () => {
  const h = await setup({ provider: 'gptsovits', includeTitleInAudio: false }); const p = h.p;
  const requests = [];
  p.requestGptSoVitsAudio = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
  const one = p.synthesizeFile(new TFile('one.md'));
  await until(() => requests.length === 1);
  const two = p.testGptSoVitsVoice();
  await until(() => requests.length === 2);
  requests[0].reject(new Error('offline')); await one;
  await until(() => requests.length === 2);
  requests[1].resolve(h.audio); await two;
  assert.equal(p.isVoiceSwitchBusy(), false);
});

test('pause state persists and prevents startup catch-up before scheduled resume', async () => {
  const h = await setup({ batchScheduleEnabled: true, batchSyncFolder: 'notes' });
  assert.equal(typeof h.p.pauseBatchGeneration, 'function');
  h.p.batchFolderPath = 'notes';
  const at = Date.now() + 60000;
  await h.p.pauseBatchGeneration(at);
  const restarted = await setup(h.p.saved);
  let called = 0;
  restarted.p.syncFolderAudio = async () => { called++; };
  restarted.p.checkStartupCatchUp();
  assert.equal(called, 0);
  assert.equal(restarted.p.batchPauseState.resumeAt, at);
  await restarted.p.resumeBatchGeneration();
  assert.equal(called, 1);
});

test('read failure clears busy path so another manual task and voice selection remain usable', async () => {
  const h = await setup({ provider: 'gptsovits', includeTitleInAudio: false });
  h.p.app.vault.read = async () => { throw new Error('read failed'); };
  await assert.rejects(h.p.synthesizeFile(new TFile('bad.md')), /read failed/);
  assert.equal(h.p.isVoiceSwitchBusy(), false);
  assert.equal(h.p.activeSynthesizingPaths.size, 0);
});

test('resuming while a voice selection is saving waits for that save', async () => {
  const h = await setup({ provider: 'gptsovits', includeTitleInAudio: false }); const p = h.p;
  await p.pauseBatchGeneration();
  let saveVoice;
  p.saveSettings = () => new Promise(resolve => { saveVoice = resolve; });
  const switchVoice = p.selectMenuVoice('gptsovits', 'gptsovitsVoicePreset', 'mengyan_acoustic_candidate');
  const requests = [];
  p.requestGptSoVitsAudio = async () => { requests.push(1); return h.audio; };
  const batch = p.synthesizeFileQuiet(new TFile('note.md'));
  const resume = p.resumeBatchGeneration();
  await turn(); assert.equal(requests.length, 0);
  saveVoice(); await switchVoice; await resume; await batch;
  assert.equal(requests.length, 1);
});

test('a failed manual generation does not discard suspended batch progress', async () => {
  const h = await setup({ provider: 'gptsovits', includeTitleInAudio: false }); const p = h.p;
  p.app.vault.read = async () => '第一段。\n第二段。';
  const requests = [];
  p.requestGptSoVitsAudio = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
  const batch = p.synthesizeFileQuiet(new TFile('same.md'));
  await until(() => requests.length === 1);
  await p.pauseBatchGeneration(); requests[0].resolve(h.audio);
  await until(() => p.batchPaused);
  p.app.vault.read = async () => '手动正文。';
  const manual = p.synthesizeFile(new TFile('same.md'));
  await until(() => requests.length === 2);
  requests[1].reject(new Error('offline')); await manual;
  await p.resumeBatchGeneration();
  await until(() => requests.length === 3);
  requests[2].resolve(h.audio); await batch;
  assert.equal(h.logs().filter(l => l.status === 'success').length, 1);
  assert.equal(p.isVoiceSwitchBusy(), false);
});

test('scheduled resume and repeated resume do not start duplicate batches', async () => {
  const h = await setup(); const p = h.p;
  p.batchFolderPath = 'notes'; await p.pauseBatchGeneration(Date.now() - 1000);
  let calls = 0;
  p.syncFolderAudio = async () => { calls++; p.isBatchSyncing = true; };
  p.checkScheduledBatchSync(); p.checkScheduledBatchSync(); await p.resumeBatchGeneration();
  await turn(); assert.equal(calls, 1);
});

test('repeated pause/resume preserves counters and never admits a second batch request', async () => {
  const h = await setup({ provider: 'gptsovits', includeTitleInAudio: false }); const p = h.p;
  p.app.vault.read = async () => '第一段。\n第二段。\n第三段。';
  const requests = [];
  p.requestGptSoVitsAudio = () => new Promise(resolve => requests.push(resolve));
  const batch = p.synthesizeFileQuiet(new TFile('three.md'));
  for (let i = 0; i < 3; i++) {
    await until(() => requests.length === i + 1);
    await p.pauseBatchGeneration(); requests[i](h.audio);
    await until(() => p.batchPaused);
    assert.equal(p.activeAudioRequests, 0);
    assert.equal(p.activeGenerationIds.size, 0);
    await Promise.all([p.resumeBatchGeneration(), p.resumeBatchGeneration()]);
  }
  await batch;
  assert.equal(requests.length, 3);
  assert.equal(p.activeAudioRequests, 0);
});

test('unloading a paused batch rejects it without submitting another request', async () => {
  const h = await setup({ provider: 'gptsovits', includeTitleInAudio: false }); const p = h.p;
  p.app.vault.read = async () => '第一段。\n第二段。';
  let finish; let calls = 0;
  p.requestGptSoVitsAudio = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const batch = p.synthesizeFileQuiet(new TFile('batch.md'));
  const settled = batch.catch(e => e);
  await until(() => finish);
  await p.pauseBatchGeneration(); finish(h.audio);
  await until(() => p.batchPaused);
  p.unloading = true; p.wakeGenerationWaiters();
  assert.match((await settled).message, /卸载/);
  assert.equal(calls, 1);
  assert.equal(p.activeAudioRequests, 0);
  assert.equal(p.activeGenerationIds.size, 0);
  assert.equal(p.activeSynthesizingPaths.size, 0);
});


test('two notes overlap with frozen voices through delayed reads, chunks and logs', async () => {
  const h = await setup({ provider: 'gptsovits', includeTitleInAudio: false }); const p = h.p;
  let readOne;
  p.app.vault.read = file => file.path === 'one.md'
    ? new Promise(resolve => { readOne = resolve; }) : Promise.resolve('第二篇第一段。\n第二篇第二段。');
  const requests = [];
  p.requestGptSoVitsAudio = (text, status, settings) => new Promise(resolve => requests.push({ text, voice: settings.gptsovitsVoicePreset, finish: () => resolve(h.audio) }));
  const one = p.synthesizeFile(new TFile('one.md'));
  await until(() => readOne);
  await p.selectMenuVoice('gptsovits', 'gptsovitsVoicePreset', 'mengyan_acoustic_candidate');
  const two = p.synthesizeFile(new TFile('two.md'));
  await until(() => requests.length === 1);
  readOne('第一篇第一段。\n第一篇第二段。');
  await until(() => requests.length === 2);
  assert.equal(p.activeSynthesizingPaths.size, 2);
  p.settings.gptsovitsVoicePreset = 'custom';
  requests[0].finish(); requests[1].finish();
  await until(() => requests.length === 4);
  assert.deepEqual(requests.map(r => r.voice), ['mengyan_acoustic_candidate', 'liufei_acoustic_candidate', 'mengyan_acoustic_candidate', 'liufei_acoustic_candidate']);
  requests[2].finish(); requests[3].finish(); await Promise.all([one, two]);
  assert.equal(h.logs().find(l => l.sourcePath === 'one.md').voiceId, 'liufei_acoustic_candidate');
  assert.equal(h.logs().find(l => l.sourcePath === 'two.md').voiceId, 'mengyan_acoustic_candidate');
  assert.equal(p.activeSynthesizingPaths.size, 0);
  assert.equal(p.activeAudioRequests, 0);
});

test('rapid duplicate submissions share a note task and save only once', async () => {
  const h = await setup({ provider: 'gptsovits', includeTitleInAudio: false }); const p = h.p;
  let finish; let count = 0; let saves = 0;
  p.requestGptSoVitsAudio = () => { count++; return new Promise(resolve => { finish = resolve; }); };
  p.saveAudioFile = async () => { saves++; return new TFile('Audio/same.wav'); };
  const one = p.synthesizeFile(new TFile('same.md'));
  const two = p.synthesizeFile(new TFile('same.md'));
  await until(() => finish); finish(h.audio);
  // A second request would leave the second promise pending.
  await one; await turn(); assert.equal(count, 1);
  await two; assert.equal(saves, 1);
});

test('local model requests alternate notes one chunk at a time and recover after failure', async () => {
  const h = await setup({ provider: 'gptsovits' }); const p = h.p;
  const requests = [];
  p.requestGptSoVitsAudioNow = (text, status, settings) => new Promise((resolve, reject) => requests.push({ text, voice: settings.gptsovitsVoicePreset, resolve, reject }));
  const one = p.generateAudio('甲一。\n甲二。');
  await until(() => requests.length === 1);
  p.settings.gptsovitsVoicePreset = 'mengyan_acoustic_candidate';
  const two = p.generateAudio('乙一。\n乙二。');
  await turn(); assert.equal(requests.length, 1, '同一个本地实例只运行一个小段请求');
  requests[0].resolve(h.audio);
  await until(() => requests.length === 2);
  assert.equal(requests[1].text, '乙一。'); requests[1].resolve(h.audio);
  await until(() => requests.length === 3);
  assert.equal(requests[2].text, '甲二。'); requests[2].resolve(h.audio);
  await until(() => requests.length === 4);
  assert.equal(requests[3].text, '乙二。'); requests[3].resolve(h.audio);
  await Promise.all([one, two]);
  assert.deepEqual(requests.map(r => r.voice), ['liufei_acoustic_candidate', 'mengyan_acoustic_candidate', 'liufei_acoustic_candidate', 'mengyan_acoustic_candidate']);
  const failure = p.requestGptSoVitsAudio('失败'); const failed = assert.rejects(failure, /offline/);
  const next = p.requestGptSoVitsAudio('下一篇');
  await until(() => requests.length === 5); requests[4].reject(new Error('offline')); await failed;
  await until(() => requests.length === 6); requests[5].resolve(h.audio); await next;
});

for (const [provider, requestMethod, voiceKey, firstVoice, nextVoice] of [
  ['volcengine', 'requestVolcengineAudio', 'volcengineVoiceType', 'BV001_streaming', 'BV002_streaming'],
  ['minimax', 'requestMiniMaxAudio', 'minimaxVoiceId', 'voice-one', 'voice-two'],
  ['replicate', 'requestReplicateAudio', 'replicateVoiceId', 'Wise_Woman', 'Deep_Voice_Man'],
  ['custom', 'requestCustomProviderAudio', 'customBodyTemplate', '{"voice":"one"}', '{"voice":"two"}'],
]) {
  test(`${provider} tasks overlap and retain voice settings for later chunks`, async () => {
    const h = await setup({ provider, [voiceKey]: firstVoice, chunkCharacters: 1, customChunkCharacters: 1,
      volcengineAppId: 'app', volcengineAccessToken: 'token', minimaxApiKey: 'token', replicateApiToken: 'token', customEndpoint: 'http://localhost/tts' });
    const p = h.p; const requests = [];
    p.getGenerationChunks = () => ['第一段', '第二段'];
    p[requestMethod] = (...args) => new Promise(resolve => requests.push({ settings: args.at(-1), resolve }));
    const one = p.generateAudio('第一篇正文'); await until(() => requests.length === 1);
    p.settings[voiceKey] = nextVoice;
    const two = p.generateAudio('第二篇正文'); await until(() => requests.length === 2);
    requests[0].resolve(h.audio); requests[1].resolve(h.audio);
    await until(() => requests.length === 4);
    assert.deepEqual(requests.map(r => r.settings[voiceKey]), [firstVoice, nextVoice, firstVoice, nextVoice]);
    requests[2].resolve(h.audio); requests[3].resolve(h.audio); await Promise.all([one, two]);
  });
}

test('pausing a concurrent batch leaves a different manual task running', async () => {
  const h = await setup({ provider: 'gptsovits', includeTitleInAudio: false }); const p = h.p;
  p.app.vault.read = async file => file.path === 'batch.md' ? '批量第一段。\n批量第二段。' : '手动正文。';
  const requests = [];
  p.requestGptSoVitsAudio = (text, status, settings) => new Promise(resolve => requests.push({ text, settings, resolve }));
  const batch = p.synthesizeFileQuiet(new TFile('batch.md')); await until(() => requests.length === 1);
  await p.selectMenuVoice('gptsovits', 'gptsovitsVoicePreset', 'mengyan_acoustic_candidate');
  const manual = p.synthesizeFile(new TFile('manual.md')); await until(() => requests.length === 2);
  await p.pauseBatchGeneration(); requests[0].resolve(h.audio); await until(() => p.batchPaused);
  assert.deepEqual([...p.activeSynthesizingPaths], ['manual.md']);
  assert.equal(p.activeAudioRequests, 1); assert.equal(p.activeGenerationIds.size, 1);
  requests[1].resolve(h.audio); await manual;
  await p.resumeBatchGeneration(); await until(() => requests.length === 3);
  assert.equal(requests[2].settings.gptsovitsVoicePreset, 'liufei_acoustic_candidate');
  requests[2].resolve(h.audio); await batch;
  assert.equal(p.activeGenerationIds.size, 0);
});

test('changing credentials during a task does not expose the old token in its log', async () => {
  const h = await setup({ provider: 'minimax', minimaxApiKey: 'original-secret', includeTitleInAudio: false }); const p = h.p;
  let fail;
  p.requestMiniMaxAudio = () => new Promise((resolve, reject) => { fail = reject; });
  const task = p.synthesizeFile(new TFile('failed.md')); await until(() => fail);
  p.settings.minimaxApiKey = 'replacement-secret';
  fail(new Error('token original-secret rejected')); await task;
  assert.ok(!h.logs()[0].error.includes('original-secret'));
});

test('a batch resumed after restart waits for current manual tasks', async () => {
  const h = await setup({ provider: 'gptsovits', includeTitleInAudio: false,
    batchPauseState: { resumeAt: null, folderPath: 'notes' } }); const p = h.p;
  const requests = [];
  p.requestGptSoVitsAudio = text => new Promise(resolve => requests.push({ text, resolve }));
  const manual = p.synthesizeFile(new TFile('manual.md')); await until(() => requests.length === 1);
  let batch;
  p.syncFolderAudio = () => { batch = p.synthesizeFileQuiet(new TFile('batch.md')); return batch; };
  await p.resumeBatchGeneration(); await turn();
  assert.equal(requests.length, 1);
  requests[0].resolve(h.audio); await manual;
  await until(() => requests.length === 2); requests[1].resolve(h.audio); await batch;
});
