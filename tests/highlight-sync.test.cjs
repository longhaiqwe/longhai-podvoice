const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');
const ctx = { module: { exports: {} }, console,
  require: () => ({ Plugin: class {}, Modal: class {}, PluginSettingTab: class {} }) };
vm.runInNewContext(esbuild.transformSync(fs.readFileSync('main.ts', 'utf8') +
  '\nmodule.exports.Player = NoteFloatingPlayer; module.exports.Aligner = NoteSentenceAligner;',
  { loader: 'ts', format: 'cjs', target: 'es2018' }).code, ctx);
const { Player, Aligner } = ctx.module.exports;
function player(offset, rate = 1) {
  const p = Object.create(Player.prototype);
  Object.assign(p, { plugin: { settings: { highlightLeadTime: offset }, savedAudioPositions: new Map() },
    audioFile: { path: 'test.wav' }, audio: { duration: 30, currentTime: 0, playbackRate: rate, paused: false },
    sentences: [0, 10, 20].map((startTime, id) => ({ id, startTime, endTime: startTime + 10, text: `句${id}` })),
    activeSentenceIndex: -1, sentenceTextEl: { textContent: '' }, isAutoScroll: true,
    highlightSentence(s) { this.highlighted = s.id; }, scrollToSentence() {},
    clearSentenceHighlight() { this.highlighted = null; } });
  return p;
}
test('new settings do not anticipate speech; explicit existing offsets survive', async () => {
  for (const value of [undefined, 0, .35, -2]) {
    const plugin = new ctx.module.exports.default();
    plugin.loadData = async () => value === undefined ? {} : { highlightLeadTime: value };
    await plugin.loadSettings();
    assert.equal(plugin.settings.highlightLeadTime, value ?? 0);
  }
});
test('missing offset does not switch to the next sentence early', () => {
  const p = player(undefined); p.audio.currentTime = 9.8; p.updatePlaybackState();
  assert.equal(p.activeSentenceIndex, 0);
});
test('two-second delay keeps the previous sentence until the corrected boundary', () => {
  const p = player(-2); p.audio.currentTime = 11.9; p.updatePlaybackState();
  assert.equal(p.activeSentenceIndex, 0);
  p.audio.currentTime = 12; p.updatePlaybackState(); assert.equal(p.activeSentenceIndex, 1);
});
test('before delayed speech begins there is no highlight, including after rewinding', () => {
  const p = player(-2); p.audio.currentTime = 12; p.updatePlaybackState();
  p.audio.currentTime = 0; p.updatePlaybackState();
  assert.equal(p.activeSentenceIndex, -1); assert.equal(p.highlighted, null); assert.equal(p.sentenceTextEl.textContent, '');
  assert.equal(Aligner.findSentenceIndex(p.sentences, -1), -1);
});
for (const rate of [0.75, 1, 2]) test(`delayed click-to-seek stays on the clicked sentence at ${rate}x`, () => {
  const p = player(-2, rate); p.seekToSentence(1);
  assert.equal(p.audio.currentTime, 10 + 2 * rate);
  p.updatePlaybackState(); assert.equal(p.activeSentenceIndex, 1);
  p.audio.currentTime += 3; p.seekToPreviousSentence();
  assert.equal(p.audio.currentTime, 10 + 2 * rate);
});
test('positive lead still scales with rate and click-to-seek does not cut off sentence start', () => {
  const p = player(.35, 2); p.audio.currentTime = 9.4; p.updatePlaybackState();
  assert.equal(p.activeSentenceIndex, 1); p.seekToSentence(1); assert.equal(p.audio.currentTime, 10);
});
