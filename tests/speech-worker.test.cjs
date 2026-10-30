const assert = require('node:assert/strict');
const { test } = require('node:test');
const { recognitionTokens } = require('../speech-timing.cjs');
test('overlapping recognition windows keep each central token once and retain audio offsets', () => {
  const result = {tokens:['前','重','点','后'],timestamps:[1.8,2,2.3,32]};
  const kept = recognitionTokens(result,28,30,60,90);
  assert.deepEqual(kept.map(t=>[t.text,t.start]),[['重',30],['点',30.3]]);
});
test('CTC start times are kept and absent duration never highlights a long silence', () => {
  const kept = recognitionTokens({tokens:['<|zh|>','你','好'],timestamps:[0,.4,5]},0,0,10,10);
  assert.equal(kept[0].start,.4); assert.equal(kept[0].end,.7);
  assert.equal(kept[1].start,5); assert.equal(kept[1].end,5.18);
});
test('decoder-provided duration is honored and clipped to audio end', () => {
  assert.deepEqual(recognitionTokens({tokens:['Hello'],timestamps:[9.8],durations:[.5]},0,0,10,10),
    [{text:'Hello',start:9.8,end:10}]);
});
test('missing timestamp arrays are rejected rather than estimated from text', () => {
  assert.throws(()=>recognitionTokens({tokens:['无'],timestamps:[]},0,0,10,10),/未返回/);
});
