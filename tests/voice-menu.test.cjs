const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');
const notices = [];
class Menu {
  constructor() { this.items = []; Menu.last = this; }
  addItem(build) {
    const item = {};
    for (const key of ['Title', 'Icon', 'Checked', 'Disabled', 'IsLabel']) {
      item[`set${key}`] = (value) => { item[key] = value; return item; };
    }
    item.onClick = (value) => { item.click = value; return item; };
    build(item); this.items.push(item); return this;
  }
  addSeparator() {}
  showAtMouseEvent() {}
}
const context = { module: { exports: {} }, console, require: () => ({
  Plugin: class {}, Modal: class {}, PluginSettingTab: class {}, Menu,
  Notice: class { constructor(message) { notices.push(message); } },
}) };
vm.runInNewContext(esbuild.transformSync(fs.readFileSync('main.ts', 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'es2018',
}).code, context);
async function setup(data = {}) {
  const plugin = new context.module.exports.default();
  plugin.loadData = async () => data;
  plugin.saveData = async (value) => { plugin.saved = JSON.parse(JSON.stringify(value)); };
  plugin.findExistingAudioForNote = () => null;
  await plugin.loadSettings();
  return plugin;
}
test('cloud voices require credentials; custom voice also requires its own code', async () => {
  const p = await setup();
  assert.ok(p.getVoiceMenuOptions().every(v => v.unavailable));
  p.settings.volcengineAppId = 'app'; p.settings.volcengineAccessToken = 'token';
  assert.equal(p.getVoiceMenuOptions().filter(v => !v.unavailable).length, 4);
  p.settings.volcengineCustomVoiceType = '   ';
  assert.ok(p.getVoiceMenuOptions().find(v => v.id === 'custom').unavailable);
  p.settings.volcengineCustomVoiceType = 'my-voice';
  assert.equal(p.getVoiceMenuOptions().filter(v => !v.unavailable).length, 5);
});
test('local menu shows two speakers and only configured or active custom voice', async () => {
  const p = await setup({ provider: 'gptsovits' });
  assert.deepEqual(Array.from(p.getVoiceMenuOptions(), v => v.name), ['刘飞', '孟岩']);
  p.settings.gptsovitsCustomRefAudio = 'reference.wav';
  assert.equal(p.getVoiceMenuOptions().find(v => v.id === 'custom'), undefined);
  p.settings.gptsovitsVoicePreset = 'custom';
  assert.ok(p.getVoiceMenuOptions().find(v => v.id === 'custom').unavailable);
  p.settings.gptsovitsCustomPromptText = '参考音频文字';
  assert.ok(p.getVoiceMenuOptions().every(v => !v.unavailable));
  p.settings.gptsovitsEndpoint = '';
  assert.ok(p.getVoiceMenuOptions().every(v => v.unavailable));
});
test('MiniMax and Replicate validate credentials and custom voice separately', async () => {
  const p = await setup({ provider: 'minimax' });
  assert.ok(p.getVoiceMenuOptions()[0].unavailable);
  p.settings.minimaxApiKey = 'key';
  assert.equal(p.getVoiceMenuOptions()[0].unavailable, '');
  p.settings.provider = 'replicate';
  assert.ok(p.getVoiceMenuOptions().every(v => v.unavailable));
  p.settings.replicateApiToken = 'token';
  assert.equal(p.getVoiceMenuOptions().filter(v => !v.unavailable).length, 17);
  p.settings.replicateCustomVoiceId = 'clone';
  assert.ok(p.getVoiceMenuOptions().every(v => !v.unavailable));
  p.settings.replicateModel = 'other/model';
  assert.equal(p.getVoiceMenuOptions().length, 0);
  p.settings.provider = 'custom';
  assert.equal(p.getVoiceMenuOptions().length, 0);
});
test('selection persists without synthesis and survives reload', async () => {
  const p = await setup({ provider: 'gptsovits' });
  p.generateAudio = () => { throw new Error('must not synthesize'); };
  await p.selectMenuVoice('gptsovits', 'gptsovitsVoicePreset', 'mengyan_acoustic_candidate');
  assert.equal(p.saved.gptsovitsVoicePreset, 'mengyan_acoustic_candidate');
  const reloaded = await setup(p.saved);
  assert.equal(reloaded.settings.gptsovitsVoicePreset, 'mengyan_acoustic_candidate');
  await p.selectMenuVoice('gptsovits', 'gptsovitsVoicePreset', 'custom');
  assert.equal(p.settings.gptsovitsVoicePreset, 'mengyan_acoustic_candidate');
});
test('failed persistence rolls selection back', async () => {
  const p = await setup({ provider: 'gptsovits' });
  p.saveData = async () => { throw new Error('disk unavailable'); };
  await p.selectMenuVoice('gptsovits', 'gptsovitsVoicePreset', 'mengyan_acoustic_candidate');
  assert.equal(p.settings.gptsovitsVoicePreset, 'liufei_acoustic_candidate');
  assert.equal(p.isVoiceSwitchBusy(), false);
});
test('in-flight synthesis and queued batch allow switching for new tasks', async () => {
  const p = await setup({ provider: 'gptsovits' });
  let finish;
  p.generateWithGptSoVits = () => new Promise(resolve => { finish = resolve; });
  const request = p.generateAudio('test');
  await p.selectMenuVoice('gptsovits', 'gptsovitsVoicePreset', 'mengyan_acoustic_candidate');
  assert.equal(p.settings.gptsovitsVoicePreset, 'mengyan_acoustic_candidate');
  finish({}); await request;
  assert.equal(p.isVoiceSwitchBusy(), false);
  p.isBatchSyncing = true;
  await p.selectMenuVoice('gptsovits', 'gptsovitsVoicePreset', 'mengyan_acoustic_candidate');
  assert.equal(p.settings.gptsovitsVoicePreset, 'mengyan_acoustic_candidate');
  p.isBatchSyncing = false;
  p.generateWithGptSoVits = async () => { throw new Error('offline'); };
  await assert.rejects(p.generateAudio('test'), /offline/);
  assert.equal(p.isVoiceSwitchBusy(), false);
});
test('menu checks current voice, disables missing config and opens plugin settings', async () => {
  const p = await setup({ provider: 'gptsovits' });
  const calls = [];
  p.manifest = { id: 'longhai-podvoice' };
  p.app = { setting: { open: () => calls.push('open'), openTabById: id => calls.push(id) } };
  const file = { path: 'note.md' };
  p.showPillContextMenu({}, { file }, file);
  assert.equal(Menu.last.items.filter(i => i.Checked).length, 1);
  assert.equal(Menu.last.items.find(i => i.Checked).Title, '刘飞');
  assert.equal(Menu.last.items.filter(i => typeof i.Checked === 'boolean').length, 2);
  Menu.last.items.find(i => i.Title === '配置音色…').click();
  assert.deepEqual(calls, ['open', 'longhai-podvoice']);
});
test('stale menus cannot change another provider or regenerate a different note', async () => {
  const p = await setup({ provider: 'gptsovits' });
  p.settings.provider = 'volcengine';
  await p.selectMenuVoice('gptsovits', 'gptsovitsVoicePreset', 'mengyan_acoustic_candidate');
  assert.equal(p.settings.gptsovitsVoicePreset, 'liufei_acoustic_candidate');
  const file = { path: 'original.md' }; const view = { file };
  p.showPillContextMenu({}, view, file);
  p.synthesize = () => { throw new Error('must not synthesize'); };
  view.file = { path: 'other.md' };
  await Menu.last.items.find(i => i.Title.includes('重新生成全文语音')).click();
});

for (const speaker of ['liufei', 'mengyan']) {
  for (const version of ['chat', 'intro', 'acoustic_candidate']) {
    test(`migrates ${speaker}_${version} to the single voice and keeps unrelated settings`, async () => {
      const p = await setup({ provider: 'gptsovits', gptsovitsVoicePreset: `${speaker}_${version}`,
        gptsovitsPreferredPresets: { liufei: 'liufei_intro', mengyan: 'mengyan_chat' },
        gptsovitsTemperature: 0.69, gptsovitsSpeed: 1.2, outputFolder: 'Existing Audio',
        pendingTasks: [{ id: 'queued' }], noteContentHashes: { 'note.md': 'hash' },
      });
      assert.equal(p.settings.gptsovitsVoicePreset, `${speaker}_acoustic_candidate`);
      assert.equal(p.settings.gptsovitsPreferredPresets, undefined);
      const config = p.getGptSoVitsConfig();
      assert.equal(config.targetGptWeight, speaker === 'liufei' ? 'GPT_weights_v2/liufei-e15.ckpt' : 'GPT_weights_v2/mengyan_v2-e25.ckpt');
      assert.equal(config.targetSovitsWeight, speaker === 'liufei' ? 'SoVITS_weights_v2/liufei_clean_20260930_e2_s160.pth' : 'SoVITS_weights_v2/mengyan_clean_20260930_e2_s166.pth');
      await p.saveSettings();
      const reloaded = await setup(p.saved);
      assert.equal(reloaded.settings.gptsovitsVoicePreset, `${speaker}_acoustic_candidate`);
      assert.equal(reloaded.settings.gptsovitsTemperature, 0.69);
      assert.equal(reloaded.settings.gptsovitsSpeed, 1.2);
      assert.equal(reloaded.settings.outputFolder, 'Existing Audio');
      assert.equal(reloaded.pendingTasks[0].id, 'queued');
      assert.equal(reloaded.noteContentHashes['note.md'], 'hash');
    });
  }
}
test('custom voice migration preserves reference and does not select built-in weights', async () => {
  const p = await setup({ provider: 'gptsovits', gptsovitsVoicePreset: 'custom',
    gptsovitsCustomRefAudio: 'my.wav', gptsovitsCustomPromptText: '我的参考文本', gptsovitsCustomPromptLang: 'zh' });
  assert.equal(p.settings.gptsovitsVoicePreset, 'custom');
  const config = p.getGptSoVitsConfig();
  assert.equal(config.refAudio, 'my.wav');
  assert.equal(config.promptText, '我的参考文本');
  assert.equal(config.targetGptWeight, '');
  assert.equal(config.targetSovitsWeight, '');
});

test('paused batch leaves existing audio voice and regeneration items enabled', async () => {
  const p = await setup({ provider: 'gptsovits' });
  p.isBatchSyncing = true;
  p.batchPaused = true;
  p.batchPauseState = { resumeAt: Date.now() + 60000, folderPath: 'notes' };
  p.findExistingAudioForNote = () => ({ path: 'Audio/note.wav', name: 'note.wav' });
  const file = { path: 'note.md' };
  p.showPillContextMenu({}, { file }, file);
  assert.ok(Menu.last.items.filter(i => typeof i.Checked === 'boolean').every(i => !i.Disabled));
  assert.equal(Menu.last.items.find(i => i.Title.includes('重新生成全文语音')).Disabled, false);
  assert.ok(Menu.last.items.some(i => i.Title.includes('批量已暂停')));
  p.activeSynthesizingPaths.add('another.md');
  p.showPillContextMenu({}, { file }, file);
  assert.ok(Menu.last.items.filter(i => typeof i.Checked === 'boolean').every(i => !i.Disabled));
  assert.equal(Menu.last.items.find(i => i.Title.includes('重新生成全文语音')).Disabled, false);
  p.activeSynthesizingPaths.add(file.path);
  p.showPillContextMenu({}, { file }, file);
  assert.equal(Menu.last.items.find(i => i.Title.includes('重新生成全文语音')).Disabled, true);
});
