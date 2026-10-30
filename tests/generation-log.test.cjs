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
    window: { setTimeout: fn => { fn(); return 1; }, clearTimeout() {} },
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

test('persists running then success, including save time and exact local model/voice', async () => {
  const h = await setup({ provider: 'gptsovits', gptsovitsVoicePreset: 'mengyan_acoustic_candidate' });
  h.p.generateWithGptSoVits = async () => { h.tick(1200); return h.audio; };
  const result = await h.p.generateAndSaveAudio('中文😀', new TFile('笔记.md'), 'note');
  const [log] = h.logs();
  assert.equal(h.writes[0].status, 'running');
  assert.equal(log.status, 'success'); assert.equal(log.durationMs, 1700);
  assert.equal(result.durationMs, log.durationMs); assert.equal(log.characterCount, 3);
  assert.equal(log.chunkCount, 1); assert.equal(log.outputPath, 'Audio/笔记.mp3');
  assert.equal(log.model, 'GPT-SoVITS'); assert.match(log.voiceName, /孟岩/);
  assert.match(log.modelWeights.gpt, /mengyan_v2-e25/); assert.match(log.modelWeights.sovits, /mengyan_clean/);
  assert.ok(log.finishedAt); assert.equal(h.p.isVoiceSwitchBusy(), false);
});

for (const provider of ['gptsovits', 'volcengine', 'minimax', 'replicate', 'custom']) {
  test(`${provider}: logged total matches actual split requests`, async () => {
    const h = await setup({ provider, chunkCharacters: 1200, customChunkCharacters: 300,
      volcengineAppId: 'app', volcengineAccessToken: 'secret', minimaxApiKey: 'secret', replicateApiToken: 'secret', customEndpoint: 'https://example.test' });
    const methods = { gptsovits: 'requestGptSoVitsAudio', volcengine: 'requestVolcengineAudio', minimax: 'requestMiniMaxAudio', replicate: 'requestReplicateAudio', custom: 'requestCustomProviderAudio' };
    const requests = [];
    h.p[methods[provider]] = async text => { requests.push(text); h.tick(100); return h.audio; };
    await h.p.generateAndSaveAudio('测试句子。'.repeat(500), new TFile('long.md'), 'note');
    assert.ok(requests.length > 1); assert.equal(h.logs()[0].chunkCount, requests.length);
    assert.equal(h.logs()[0].durationMs, requests.length * 100 + 500);
    if (provider === 'volcengine') assert.ok(requests.every(t => t.length <= 800));
  });
}

test('second segment failure retains total planned count and redacts error credentials', async () => {
  const h = await setup({ provider: 'minimax', minimaxApiKey: 'private-key', chunkCharacters: 80 });
  let n = 0;
  h.p.requestMiniMaxAudio = async () => {
    h.tick(100);
    if (++n === 2) throw new Error('request private-key at https://example.test/?token=secret failed');
    return h.audio;
  };
  await assert.rejects(h.p.generateAndSaveAudio('测试句子。'.repeat(60), new TFile('failed.md'), 'note'), /failed/);
  const [log] = h.logs();
  assert.equal(log.status, 'failed'); assert.equal(log.durationMs, 200);
  assert.ok(log.chunkCount > n); assert.doesNotMatch(log.error, /private-key|example.test|token=secret/);
});

test('audio save error is a generation failure, not a synthesis success', async () => {
  const h = await setup();
  h.p.generateAudio = async () => { h.tick(200); return h.audio; };
  h.p.saveAudioFile = async () => { h.tick(300); throw new Error('disk full'); };
  await assert.rejects(h.p.generateAndSaveAudio('内容', new TFile('note.md'), 'note'), /disk full/);
  assert.equal(h.logs()[0].status, 'failed'); assert.equal(h.logs()[0].durationMs, 500);
});

test('simultaneous generations use independent files and serialized directory creation', async () => {
  const h = await setup();
  h.p.generateAudio = async () => h.audio;
  await Promise.all(['one.md', 'two.md', 'one.md'].map(path => h.p.generateAndSaveAudio('内容', new TFile(path), 'selection')));
  assert.equal(h.disk.size, 3); assert.equal(new Set(h.logs().map(l => l.id)).size, 3);
  assert.ok(h.logs().every(l => l.status === 'success' && l.mode === 'selection'));
});

test('log disk failure reports warning but preserves generated audio and later writes recover', async () => {
  const h = await setup();
  h.p.generateAudio = async () => h.audio;
  const write = h.p.app.vault.adapter.write;
  h.p.app.vault.adapter.write = async () => { throw new Error('read only'); };
  const result = await h.p.generateAndSaveAudio('内容', new TFile('note.md'), 'note');
  assert.equal(result.value.path, 'Audio/note.mp3'); assert.ok(h.notices.some(n => n.includes('日志写入失败')));
  assert.equal(h.p.isVoiceSwitchBusy(), false);
  h.p.app.vault.adapter.write = write;
  await h.p.generateAndSaveAudio('内容', new TFile('next.md'), 'note');
  assert.equal(h.logs()[0].status, 'success');
});

test('missing Replicate custom voice still creates a failed log', async () => {
  const h = await setup({ provider: 'replicate', replicateApiToken: 'key', replicateVoiceId: 'custom', replicateCustomVoiceId: '' });
  await assert.rejects(h.p.generateAndSaveAudio('内容', new TFile('note.md'), 'note'), /Custom voice ID/);
  assert.equal(h.logs()[0].status, 'failed');
});

test('preview always records one request and displays its duration', async () => {
  const h = await setup({ provider: 'gptsovits', chunkCharacters: 1 });
  h.p.requestGptSoVitsAudio = async () => { h.tick(1250); return h.audio; };
  await h.p.testGptSoVitsVoice();
  assert.equal(h.logs()[0].mode, 'preview'); assert.equal(h.logs()[0].chunkCount, 1);
  assert.ok(h.notices.some(n => n.includes('本次用时 1.3 秒')));
});

for (const mode of ['note', 'selection', 'batch']) {
  test(`${mode} public flow records and reports duration`, async () => {
    const h = await setup();
    h.p.generateAudio = async () => { h.tick(1000); return h.audio; };
    const file = new TFile('note.md');
    if (mode === 'batch') {
      const folder = new TFolder('notes', [file]);
      h.p.checkNoteAudioStatus = () => ({ needsGeneration: true });
      await h.p.syncFolderAudio(folder);
    } else if (mode === 'note') await h.p.synthesizeFile(file);
    else await h.p.synthesize({ file }, mode, { getSelection: () => 'selected' });
    assert.equal(h.logs()[0].mode, mode); assert.equal(h.logs()[0].status, 'success');
    assert.ok(h.notices.some(n => /本次用时.*1.5 秒/.test(n)));
  });
}

test('custom async timeout stays pending; restart recovery updates the same log with original metadata', async () => {
  const h = await setup({ provider: 'custom', customEndpoint: 'http://localhost/tts', customBodyTemplate: '{"text":"{{text}}","model":"model-one","voice":"voice-one"}' });
  h.p.generateAudio = async (text, status, source, log) => {
    await h.p.rememberPendingTask({ task_id: 'task-one' }, {}, source, 'http://localhost/status', text.length, log);
    h.tick(3000); throw new Error('timeout');
  };
  await assert.rejects(h.p.generateAndSaveAudio('正文', new TFile('note.md'), 'note'), /后台任务待完成/);
  const original = h.logs()[0]; assert.equal(original.status, 'pending'); assert.equal(original.finishedAt, undefined);
  const reloaded = await setup({ ...h.p.saved, provider: 'minimax', minimaxModel: 'new-model' }, h.disk);
  reloaded.context.request = async () => ({ json: { status: 'succeeded', audio_url: 'http://localhost/audio' } });
  reloaded.p.downloadAudio = async () => reloaded.audio;
  reloaded.files.set('note.md', new TFile('note.md'));
  await reloaded.p.checkPendingTasks();
  const [log] = reloaded.logs();
  assert.equal(reloaded.disk.size, 1); assert.equal(log.id, original.id); assert.equal(log.status, 'success');
  assert.equal(log.model, 'model-one'); assert.equal(log.voiceId, 'voice-one');
  assert.equal(log.durationBasis, 'wall-clock'); assert.equal(log.error, undefined);
  assert.equal(reloaded.p.pendingTasks.length, 0);
  assert.ok(reloaded.notices.some(n => n.includes('含后台等待')));
});

test('recovered provider failure updates existing log and removes pending task', async () => {
  const h = await setup();
  const log = h.p.createGenerationLog('内容', 'note', new TFile('note.md'));
  h.p.pendingTasks.push({ id: 'fail', sourcePath: 'note.md', statusUrl: 'https://example.test', headers: {}, generationLog: log });
  h.context.request = async () => ({ json: { status: 'failed', error: 'provider failed' } });
  await h.p.checkPendingTasks();
  assert.equal(h.logs()[0].status, 'failed'); assert.match(h.logs()[0].error, /provider failed/);
  assert.equal(h.p.pendingTasks.length, 0);
});

test('recent log viewer handles empty/corrupt files and displays persisted metadata', async () => {
  const h = await setup();
  const empty = new h.context.LogModal(h.p.app); await empty.onOpen();
  assert.match(empty.contentEl.allText(), /暂无记录/);
  h.p.generateAudio = async () => h.audio;
  await h.p.generateAndSaveAudio('内容', new TFile('note.md'), 'note');
  h.disk.set('TTS Logs/2099-01/broken.json', 'partial');
  const viewer = new h.context.LogModal(h.p.app); await viewer.onOpen();
  assert.match(viewer.contentEl.allText(), /成功 · note.md/);
  assert.match(viewer.contentEl.allText(), /2 字符 · 1 段/);
  assert.match(viewer.contentEl.allText(), /已跳过 1 份/);
});
