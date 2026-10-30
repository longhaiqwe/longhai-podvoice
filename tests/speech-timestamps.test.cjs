const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');
const ctx = { module: { exports: {} }, console,
  require: name => name === 'obsidian' ? { Plugin: class {}, Modal: class {}, PluginSettingTab: class {}, Notice: class {} } : require(name) };
vm.runInNewContext(esbuild.transformSync(fs.readFileSync('main.ts', 'utf8') + `
module.exports.mapSpeech = typeof alignSentencesToSpeech === 'undefined' ? undefined : alignSentencesToSpeech;
module.exports.validTiming = typeof isSpeechTiming === 'undefined' ? undefined : isSpeechTiming;
module.exports.Player = NoteFloatingPlayer; module.exports.Aligner = NoteSentenceAligner;`,
  { loader: 'ts', format: 'cjs', target: 'es2018' }).code, ctx);
const api = ctx.module.exports;
function map(sentences, tokens) {
  assert.equal(typeof api.mapSpeech, 'function');
  return api.mapSpeech(sentences, tokens, s => s.text);
}
function sentences(text) { return api.Aligner.parseSentences(text, '', false); }
function tokens(text, start = 1, step = .2) {
  return Array.from(text).map((text, i) => ({ text, start: start + i * step, end: start + i * step + .1 }));
}
test('audio token starts override weighted estimates and preserve leading silence', () => {
  const s = sentences('车内陷入了沉默。对话到此结束。');
  const t = [...tokens('车内陷入了沉默', 8), ...tokens('对话到此结束', 14)];
  assert.equal(map(s, t), 2);
  assert.equal(s[0].startTime, 8); assert.equal(s[1].startTime, 14);
  assert.equal(api.Aligner.findSentenceIndex(s, 7.9), -1);
  assert.equal(api.Aligner.findSentenceIndex(s, 13), -1);
  assert.equal(api.Aligner.findSentenceIndex(s, 14), 1);
  assert.equal(api.Aligner.findSentenceIndex(s, 29), -1);
});
test('normalization handles punctuation, English token boundaries and repeated sentences in order', () => {
  const s = sentences('“你好！”\n《Same as Ever》很好。\n你好！');
  const t = [...tokens('你好', 1), ...tokens('sameasever很好', 3), ...tokens('你好', 8)];
  assert.equal(map(s, t), 3);
  assert.deepEqual(Array.from(s, x => x.startTime), [1, 3, 8]);
});
test('a missing sentence does not inherit invented timing; subsequent anchors still match', () => {
  const s = sentences('今天阳光很好。完全没有读出的内容。明天我们再见。');
  assert.equal(map(s, [...tokens('今天阳光很好', 1), ...tokens('明天我们再见', 10)]), 2);
  assert.equal(s[1].timingSource, 'unmatched'); assert.equal(s[1].startTime, -1);
  assert.equal(s[2].startTime, 10);
});
test('small internal recognition errors can match but missing sentence openings cannot', () => {
  const s = sentences('我们一起去公园散步。春天阳光照在大地上。');
  assert.equal(map(s, [...tokens('我们一起去公圆散步', 1), ...tokens('阳光照在大地上', 10)]), 1);
  assert.equal(s[0].startTime, 1); assert.equal(s[1].timingSource, 'unmatched');
});
test('unrelated audio never qualifies as aligned', () => {
  const s = sentences('这是一本关于投资的书。');
  assert.equal(map(s, tokens('今天的天气预报是晴转多云')), 0);
});
test('cache validation rejects other audio, malformed or out-of-order timestamps', () => {
  assert.equal(typeof api.validTiming, 'function');
  const value = { version: 1, engine: 'sensevoice', audioSha256: 'a'.repeat(64), duration: 20, tokens: tokens('你好') };
  assert.equal(api.validTiming(value, 'a'.repeat(64)), true);
  assert.equal(api.validTiming(value, 'b'.repeat(64)), false);
  for (const bad of [[], [{ text: '坏', start: -1, end: 1 }], [{ text: '坏', start: 2, end: 1 }],
    [{ text: '坏', start: 1, end: 21 }], [...value.tokens].reverse()]) {
    assert.equal(api.validTiming({ ...value, tokens: bad }, value.audioSha256), false);
  }
});
test('real timestamps ignore old manual delay at any playback speed', () => {
  for (const rate of [.75, 1, 2]) {
    const p = Object.create(api.Player.prototype);
    Object.assign(p, { hasSpeechTiming: true, plugin: { settings: { highlightLeadTime: -2 } },
      audio: { playbackRate: rate, duration: 30 } });
    assert.equal(p.getHighlightOffset(), 0);
    assert.equal(p.getSentenceSeekTime({ startTime: 12 }), 12);
  }
});

test('cache is reused by audio hash; missing or stale cache triggers local analysis', async () => {
  const p = new api.default();
  const data = new TextEncoder().encode('audio fixture').buffer;
  const hash = require('node:crypto').createHash('sha256').update(new Uint8Array(data)).digest('hex');
  const cached = { version: 1, engine: 'sensevoice', audioSha256: hash, duration: 10, tokens: tokens('你好') };
  let reads = 0;
  p.app = { vault: { readBinary: async () => { reads++; return data; }, adapter: { read: async () => JSON.stringify(cached) } } };
  const value = await p.getSpeechTiming({path:'test.wav'});
  assert.equal(value.audioSha256, hash); assert.equal(reads, 1);
  cached.audioSha256 = 'b'.repeat(64);
  await assert.rejects(p.getSpeechTiming({path:'test.wav'}), /桌面端/);
});
test('simultaneous requests share one job; failures allow retry and never block the queue', async () => {
  const p = new api.default(); let resolve, calls = 0;
  p.loadOrCreateSpeechTiming = async () => { calls++; return new Promise(r => { resolve = r; }); };
  const first = p.getSpeechTiming({path:'one.wav'}), second = p.getSpeechTiming({path:'one.wav'});
  await new Promise(r => setImmediate(r)); assert.equal(calls, 1);
  resolve('result'); assert.equal(await first, 'result'); assert.equal(await second,'result');
  p.loadOrCreateSpeechTiming = async () => { calls++; throw new Error('failed'); };
  await assert.rejects(p.getSpeechTiming({path:'one.wav'}), /failed/);
  p.loadOrCreateSpeechTiming = async () => 'retry';
  assert.equal(await p.getSpeechTiming({path:'one.wav'}), 'retry');
});
test('disposed player ignores delayed alignment result', async () => {
  const p = Object.create(api.Player.prototype); let finish;
  Object.assign(p, { plugin: { getSpeechTiming: () => new Promise(r=>{finish=r;}) },
    audioFile: {}, destroyed:false, timingPending:true, hasSpeechTiming:false,
    updatePlaybackState(){ throw new Error('must not render'); } });
  const pending = p.loadSpeechTiming('note'); p.destroyed = true; finish({tokens:[]});
  await pending; assert.equal(p.hasSpeechTiming,false);
});
test('duration metadata never stretches or overwrites audio-derived timestamps', () => {
  const p = Object.create(api.Player.prototype), listeners = new Map();
  Object.assign(p, { hasSpeechTiming:true, sentences:[{startTime:4,endTime:6,weight:1,timingSource:'speech'}],
    audio:{duration:30,readyState:1,addEventListener(name,fn){listeners.set(name,fn);}}, cleanupFns:[] });
  p.bindAudioEvents(); listeners.get('durationchange')();
  assert.equal(p.sentences[0].startTime,4); assert.equal(p.sentences[0].endTime,6);
});
test('next/previous navigation crosses gaps and skips unrecognized sentences', () => {
  const p = Object.create(api.Player.prototype);
  Object.assign(p, {hasSpeechTiming:true,audio:{currentTime:8},sentences:[
    {startTime:1,timingSource:'speech'}, {startTime:-1,timingSource:'unmatched'}, {startTime:10,timingSource:'speech'}],
    seekToSentence(index){this.selected=index;}});
  p.seekToNextSentence(); assert.equal(p.selected,2);
  p.seekToPreviousSentence(); assert.equal(p.selected,0);
});
test('spoken Chinese numerals match numbered titles and calendar years', () => {
  const s = sentences('27 我的新书。\n第二次世界大战始于1939年的骑兵时代。');
  assert.equal(map(s, [...tokens('二十七我的新书', 1), ...tokens('第二次世界大战始于一九三九年的骑兵时代', 10)]), 2);
  assert.equal(s[0].startTime, 1); assert.equal(s[1].startTime, 10);
});
test('a minor tail recognition error retains the reliable sentence onset without inventing its end', () => {
  const s = sentences('需求是发明之母。');
  const t = tokens('需求是发明之目', 4);
  assert.equal(map(s,t),1); assert.equal(s[0].startTime,4); assert.equal(s[0].endTime,t[5].end);
});
