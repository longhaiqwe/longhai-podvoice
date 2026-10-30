const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');

// Small DOM/Obsidian doubles, following the existing tests. No plugin load or live vault writes.
class Element {
  constructor(tag = 'div', options = {}) {
    this.tag = tag; this.children = []; this.dataset = {}; this.scrollTop = 0;
    this.textContent = options.text || ''; this.cls = options.cls || ''; this.events = {};
  }
  createEl(tag, options) { return this.appendChild(new Element(tag, options)); }
  createDiv(options) { return this.createEl('div', options); }
  appendChild(el) { el.parentElement = this; this.children.push(el); return el; }
  empty() { this.children = []; }
  addClass(name) { this.cls += ' ' + name; }
  get childElementCount() { return this.children.length; }
  addEventListener(event, callback) { this.events[event] = callback; }
  setCustomValidity(value) { this.validityMessage = value; }
  contains(el) { return this === el || this.children.some(child => child.contains(el)); }
  focus() { document.activeElement = this; }
  querySelectorAll(selector) {
    const match = el => selector.split(',').some(part => {
      part = part.trim();
      if (part === 'details[data-fold]') return el.tag === 'details' && el.dataset.fold;
      if (part.startsWith('.')) return el.cls.split(' ').includes(part.slice(1));
      return el.tag === part;
    });
    return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const document = { activeElement: null, createElement: tag => new Element(tag) };
class Setting {
  constructor(parent) {
    this.settingEl = parent.createDiv({ cls: 'setting-item' }); this.settingEl.setting = this;
    this.nameEl = this.settingEl.createDiv({ cls: 'setting-item-name' });
    this.descEl = this.settingEl.createDiv({ cls: 'setting-item-description' });
  }
  setName(value) { this.nameEl.textContent = value; return this; }
  setDesc(value) { this.descEl.textContent = value; return this; }
  setHeading() { return this; }
  add(kind, callback) {
    const el = this.settingEl.createEl(kind === 'dropdown' ? 'select' : kind === 'button' ? 'button' : kind === 'textarea' ? 'textarea' : 'input');
    const c = { kind, inputEl: el, buttonEl: el, options: {},
      setValue(value) { this.value = value; return this; },
      addOption(key, label) { this.options[key] = label; return this; },
      setButtonText(value) { this.label = value; return this; },
      setDisabled(value) { this.disabled = value; return this; },
      setCta() { return this; }, setLimits() { return this; }, setDynamicTooltip() { return this; },
      onChange(callback) { this.change = callback; return this; },
      onClick(callback) { this.click = callback; return this; },
    };
    this.control = c; callback(c); return this;
  }
  addDropdown(cb) { return this.add('dropdown', cb); }
  addToggle(cb) { return this.add('toggle', cb); }
  addText(cb) { return this.add('text', cb); }
  addTextArea(cb) { return this.add('textarea', cb); }
  addSlider(cb) { return this.add('slider', cb); }
  addButton(cb) { return this.add('button', cb); }
}
class TFile { constructor(path) { this.path = path; this.basename = path.split('/').pop().replace(/\.[^.]+$/, ''); this.extension = path.split('.').pop(); } }
class TFolder { constructor(path) { this.path = path; this.name = path; this.children = []; } }
class FileSystemAdapter { getBasePath() { return '/vault'; } }
let nativeResult;
let nativeOptions;
const notices = [];
const context = {
  module: { exports: {} }, console, document,
  window: { localStorage: { getItem: () => 'zh' } }, navigator: { language: 'zh-CN' },
  require: name => name === 'path' ? require('node:path') : name === '@electron/remote'
    ? { dialog: { showOpenDialog: async options => { nativeOptions = options; return nativeResult; } } }
    : ({ Plugin: class {}, Modal: class {}, Notice: class { constructor(message) { notices.push(message); } }, Setting, TFile, TFolder, FileSystemAdapter,
    PluginSettingTab: class { constructor(app) { this.app = app; this.containerEl = new Element(); } },
  }),
};
vm.runInNewContext(esbuild.transformSync(fs.readFileSync('main.ts', 'utf8') + '\nglobalThis.SettingsTab = NoteTtsSettingTab;', {
  loader: 'ts', format: 'cjs', target: 'es2018',
}).code, context);
const snapshot = value => JSON.parse(JSON.stringify(value));
async function setup(data = {}, entries = [], desktop = false) {
  const plugin = new context.module.exports.default();
  plugin.loadData = async () => data;
  plugin.saves = 0;
  plugin.saveData = async value => { plugin.saves++; plugin.saved = snapshot(value); };
  plugin.getStorageStats = async () => { plugin.scans++; return { count: 0, totalBytes: 0, orphanCount: 0 }; };
  plugin.scans = 0;
  plugin.refreshAllInlineButtons = () => {};
  await plugin.loadSettings();
  const before = snapshot(plugin.settings);
  const app = { vault: {
    adapter: desktop ? new FileSystemAdapter() : {},
    getAllLoadedFiles: () => entries,
    getAbstractFileByPath: path => entries.find(file => file.path === path),
    getRoot: () => new TFolder('/'),
  } };
  const tab = new context.SettingsTab(app, plugin); tab.display();
  return { plugin, tab, before };
}
function row(tab, name) { return tab.containerEl.querySelectorAll('.setting-item').map(el => el.setting).find(s => s.nameEl.textContent === name); }
function fold(tab, id) { return tab.containerEl.querySelectorAll('details[data-fold]').find(el => el.dataset.fold === id); }

test('desktop picker opens a native directory dialog and saves a vault-relative folder', async () => {
  const entries = [new TFolder('Notes'), new TFolder('Notes/播客')];
  const { plugin, tab } = await setup({ batchSyncFolder: 'Notes' }, entries, true);
  const setting = row(tab, '笔记目录');
  assert.equal(setting.control.kind, 'button');
  assert.equal(setting.control.label, '选择文件夹…');
  nativeResult = { canceled: false, filePaths: ['/vault/Notes/播客'] };
  await setting.control.click();
  assert.deepEqual(snapshot(nativeOptions.properties), ['openDirectory']);
  assert.equal(nativeOptions.defaultPath, '/vault/Notes');
  assert.equal(plugin.saved.batchSyncFolder, 'Notes/播客');
  assert.equal(setting.descEl.textContent, 'Notes/播客');
  assert.equal(setting.control.disabled, false);
  const calls = [];
  plugin.syncFolderAudio = async (...args) => calls.push(args);
  await row(tab, '立即生成目录音频').control.click();
  assert.deepEqual(calls, [['Notes/播客', false]]);
  nativeResult = { canceled: false, filePaths: ['/vault'] };
  await setting.control.click();
  assert.equal(plugin.saved.batchSyncFolder, '/');
});

test('native picker cancellation, outside-vault folders, missing folders and save errors retain the old setting', async () => {
  const { plugin, tab } = await setup({ batchSyncFolder: 'Notes' }, [new TFolder('Notes')], true);
  const setting = row(tab, '笔记目录');
  for (const result of [
    { canceled: true, filePaths: [] },
    { canceled: false, filePaths: ['/vault-sibling/Notes'] },
    { canceled: false, filePaths: ['/elsewhere'] },
    { canceled: false, filePaths: ['/vault/missing'] },
  ]) {
    nativeResult = result;
    await setting.control.click();
    assert.equal(plugin.settings.batchSyncFolder, 'Notes');
    assert.equal(plugin.saves, 0);
    assert.equal(setting.control.disabled, false);
  }
  nativeResult = { canceled: false, filePaths: ['/vault'] };
  plugin.saveSettings = async () => { throw new Error('Write failed'); };
  await setting.control.click();
  assert.equal(plugin.settings.batchSyncFolder, 'Notes');
  assert.equal(setting.descEl.textContent, 'Notes');
  assert.equal(notices.at(-1), 'Write failed');
});

test('notes folder dropdown lists folders only and persists a nested selection used by generation', async () => {
  const entries = [new TFolder('/'), new TFolder('Notes'), new TFolder('Notes/播客'), new TFile('Notes/a.md')];
  const { plugin, tab } = await setup({}, entries);
  const control = row(tab, '笔记目录').control;
  assert.equal(control.kind, 'dropdown');
  assert.deepEqual(Object.keys(control.options), ['', '/', 'Notes', 'Notes/播客']);
  assert.equal(plugin.saves, 0);
  await control.change('Notes/播客');
  assert.equal(plugin.saved.batchSyncFolder, 'Notes/播客');
  const calls = [];
  plugin.syncFolderAudio = async (...args) => calls.push(args);
  await row(tab, '立即生成目录音频').control.click();
  assert.deepEqual(calls, [['Notes/播客', false]]);
  const reloaded = await setup(plugin.saved, entries);
  assert.equal(row(reloaded.tab, '笔记目录').control.value, 'Notes/播客');
});

test('missing saved folders are preserved and vault root resolves without an output-folder fallback', async () => {
  const { plugin, tab } = await setup({ batchSyncFolder: 'Old folder' });
  assert.equal(row(tab, '笔记目录').control.value, 'Old folder');
  assert.match(row(tab, '笔记目录').control.options['Old folder'], /请重新选择/);
  assert.equal(plugin.saves, 0);
  await row(tab, '笔记目录').control.change('/');
  const root = new TFolder('/');
  let visited = false;
  Object.defineProperty(root, 'children', { get() { visited = true; return []; } });
  plugin.app = { vault: { getRoot: () => root, getAbstractFileByPath: () => { throw new Error('Root must resolve directly'); } } };
  await plugin.syncFolderAudio(plugin.settings.batchSyncFolder, false);
  assert.equal(visited, true);
});

for (const provider of ['volcengine', 'gptsovits', 'minimax', 'replicate', 'custom']) {
  test(`opening ${provider} settings never changes or saves existing configuration`, async () => {
    const { plugin, tab, before } = await setup({ provider, removeUrls: false, skipLinePatterns: '^private',
      outputFolder: 'My Audio', highlightLeadTime: 0, gptsovitsTemperature: 0.69,
      gptsovitsPreferredPresets: { liufei: 'liufei_intro' }, customHeaders: '{"secret":"existing"}',
      replicateVoiceId: 'my-unlisted-voice', pendingTasks: [{ id: 'queued' }], noteContentHashes: { 'note.md': 'hash' },
    });
    tab.renderSettings();
    assert.deepEqual(snapshot(plugin.settings), before);
    assert.equal(plugin.saves, 0); assert.equal(plugin.scans, 0);
    assert.equal(row(tab, '文本清理').control.value, 'custom');
    assert.equal(row(tab, '高亮同步').control.value, '0');
    assert.equal(plugin.pendingTasks[0].id, 'queued');
    assert.equal(plugin.noteContentHashes['note.md'], 'hash');
  });
}

test('connection opens only when credentials are missing; tuning and advanced start folded', async () => {
  let view = await setup();
  assert.equal(fold(view.tab, 'connection').open, true);
  view = await setup({ volcengineAppId: 'app', volcengineAccessToken: 'secret' });
  assert.equal(fold(view.tab, 'connection').open, false);
  assert.equal(fold(view.tab, 'voice-volcengine').open, false);
  assert.equal(fold(view.tab, 'advanced').open, false);
});

test('dependent rows disappear without resetting values and return when re-enabled', async () => {
  const { plugin, tab } = await setup({ titleButtonPosition: 'bottom', frontmatterKey: 'podcast', lineBreakPauseType: 'comma', textCleanupMode: 'custom' });
  for (const [toggle, child, key, value] of [
    ['显示「听全文」按钮', '按钮位置', 'titleButtonPosition', 'bottom'],
    ['在笔记属性中记录音频', '音频属性名', 'frontmatterKey', 'podcast'],
    ['行尾自动添加停顿', '行尾停顿符号', 'lineBreakPauseType', 'comma'],
    ['逐句高亮', '高亮同步', 'highlightLeadTime', 0],
  ]) {
    await row(tab, toggle).control.change(false);
    assert.equal(row(tab, child), undefined); assert.equal(plugin.settings[key], value);
    await row(tab, toggle).control.change(true);
    assert.ok(row(tab, child)); assert.equal(plugin.settings[key], value);
  }
});

test('recommended cleanup changes only cleanup rules; custom persists across reopen', async () => {
  const { plugin, tab } = await setup({ removeUrls: false, skipLinePatterns: '^keep', chunkCharacters: 77, includeTitleInAudio: false, gptsovitsTemperature: 0.6 });
  await row(tab, '文本清理').control.change('recommended');
  assert.equal(plugin.settings.removeUrls, true); assert.notEqual(plugin.settings.skipLinePatterns, '^keep');
  assert.equal(plugin.settings.chunkCharacters, 77); assert.equal(plugin.settings.includeTitleInAudio, false);
  assert.equal(plugin.settings.gptsovitsTemperature, 0.6);
  assert.equal(row(tab, '移除裸 URL'), undefined);
  await row(tab, '文本清理').control.change('custom');
  const reloaded = await setup(plugin.saved);
  assert.ok(row(reloaded.tab, '移除裸 URL'));
});

for (const [keepOnlyLatestAudio, audioNamingMode, expected] of [[true, 'clean', 'latest'], [true, 'timestamp', 'latest'], [false, 'clean', 'legacy'], [false, 'timestamp', 'history']]) {
  test(`legacy storage ${keepOnlyLatestAudio}/${audioNamingMode} retains actual file behavior`, async () => {
    const { plugin, tab, before } = await setup({ keepOnlyLatestAudio, audioNamingMode, associateNoteFrontmatter: false });
    assert.equal(row(tab, '历史版本').control.value, expected);
    assert.deepEqual(snapshot(plugin.settings), before);
    const files = new Map(); const deleted = [];
    plugin.app = { vault: {
      getAbstractFileByPath: path => files.get(path) || (path === 'TTS Audio' ? {} : null),
      createBinary: async path => { const f = new TFile(path); files.set(path, f); return f; },
      modifyBinary: async () => {}, getFiles: () => [...files.values()], delete: async f => { deleted.push(f.path); files.delete(f.path); },
    } };
    files.set('TTS Audio/note-2020-01-01T00-00-00.wav', new TFile('TTS Audio/note-2020-01-01T00-00-00.wav'));
    const audio = await plugin.saveAudioFile(new TFile('note.md'), { data: new ArrayBuffer(1), extension: 'wav' });
    assert.equal(audio.path === 'TTS Audio/note.wav', expected !== 'history');
    assert.equal(deleted.length, keepOnlyLatestAudio ? 1 : 0);
    await row(tab, '历史版本').control.change('history');
    assert.equal(plugin.settings.keepOnlyLatestAudio, false); assert.equal(plugin.settings.audioNamingMode, 'timestamp');
  });
}

test('schedule controls hide while manual batch remains reachable; disabling preserves schedule', async () => {
  const { plugin, tab } = await setup({ batchScheduleTime: '07:45', batchSyncFolder: 'Queue', batchCatchUpOnStartup: false });
  assert.equal(row(tab, '更新时间'), undefined); assert.ok(fold(tab, 'manual-batch'));
  await row(tab, '每天自动更新').control.change(true);
  assert.equal(row(tab, '更新时间').control.value, '07:45');
  assert.equal(row(tab, '错过时间后补跑').control.value, false);
  await row(tab, '更新时间').control.change('29:99');
  assert.equal(plugin.settings.batchScheduleTime, '07:45');
  await row(tab, '每天自动更新').control.change(false);
  assert.equal(plugin.settings.batchSyncFolder, 'Queue'); assert.equal(plugin.settings.batchScheduleTime, '07:45');
});

test('zero lead time and imported dropdown values survive unrelated changes', async () => {
  const { plugin, tab } = await setup({ highlightLeadTime: 0.22, provider: 'replicate', replicateVoiceId: 'old-custom-id' });
  assert.equal(row(tab, '音色').control.value, 'old-custom-id');
  assert.ok(row(tab, '音色').control.options['old-custom-id']);
  assert.equal(row(tab, '高亮同步').control.value, '0.22');
  await row(tab, '高亮同步').control.change('0');
  assert.equal(plugin.settings.highlightLeadTime, 0);
  fold(tab, 'appearance').open = true;
  await row(tab, '显示「听全文」按钮').control.change(false);
  assert.equal(fold(tab, 'appearance').open, true);
  assert.equal(row(tab, '高亮同步').control.value, '0');
});

test('Replicate custom fields are conditional and model blur updates controls', async () => {
  const { plugin, tab } = await setup({ provider: 'replicate', replicateCustomVoiceId: 'existing-clone' });
  assert.equal(row(tab, '自定义音色 ID'), undefined);
  await row(tab, '音色').control.change('custom');
  assert.equal(row(tab, '自定义音色 ID').control.value, 'existing-clone');
  const model = row(tab, '模型').control;
  await model.change('owner/another-model'); model.inputEl.events.blur();
  assert.equal(row(tab, '音色'), undefined); assert.ok(row(tab, '模型版本')); assert.ok(row(tab, '请求内容模板'));
  assert.equal(plugin.settings.replicateCustomVoiceId, 'existing-clone');
});

for (const oldPreset of ['liufei_chat', 'liufei_intro', 'mengyan_chat', 'mengyan_intro', 'mengyan_acoustic_candidate']) {
  test(`settings offer only one version per speaker after loading ${oldPreset}`, async () => {
    const { plugin, tab } = await setup({ provider: 'gptsovits', gptsovitsVoicePreset: oldPreset });
    const voice = row(tab, '音色').control;
    assert.deepEqual(Object.values(voice.options), ['刘飞', '孟岩', '自定义音色']);
    assert.equal(voice.value, oldPreset.startsWith('mengyan') ? 'mengyan_acoustic_candidate' : 'liufei_acoustic_candidate');
    await voice.change('liufei_acoustic_candidate');
    assert.equal(plugin.saved.gptsovitsVoicePreset, 'liufei_acoustic_candidate');
  });
}

test('highlight sync offers a persistent delay without overwriting existing offsets', async () => {
  const { plugin, tab } = await setup({ highlightLeadTime: .35 });
  const setting = row(tab, '高亮同步');
  assert.equal(setting.control.value, '0.35');
  assert.equal(setting.control.options['-2'], '延后 2 秒');
  await setting.control.change('-2');
  assert.equal(plugin.saved.highlightLeadTime, -2);
  tab.renderSettings(); assert.equal(row(tab, '高亮同步').control.value, '-2');
});
