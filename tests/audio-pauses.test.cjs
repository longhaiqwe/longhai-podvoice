const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');
const code = esbuild.transformSync(fs.readFileSync('main.ts','utf8') + '\nmodule.exports.combineAudioResults = combineAudioResults;\nmodule.exports.parseWav = parseWav;', {loader:'ts',format:'cjs',target:'es2018'}).code;
const context = {module:{exports:{}}, console, require:()=>({Plugin:class{},Modal:class{},PluginSettingTab:class{}})};
vm.runInNewContext(code,context);
const {combineAudioResults,parseWav}=context.module.exports;
function wav(rate, channels=1, bits=16) {
  const samples=10, align=channels*bits/8;
  const b=Buffer.alloc(44+samples*align);
  b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(channels,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*align,28);
  b.writeUInt16LE(align,32);b.writeUInt16LE(bits,34);b.write('data',36);b.writeUInt32LE(samples*align,40);b.fill(bits===8?200:64,44);
  return {data:b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),extension:'wav',mimeType:'audio/wav'};
}
test('local request boundaries have half a second of silence',()=> {
  for (const [rate,channels,bits] of [[32000,1,16],[24000,2,16],[16000,1,8]]) {
    const a=wav(rate,channels,bits), align=channels*bits/8;
    const parsed=parseWav(combineAudioResults([a,a],'GPT-SoVITS',.5).data);
    assert.equal(parsed.data.byteLength,(20+rate*.5)*align);
    assert.ok(new Uint8Array(parsed.data).slice(10*align,(10+rate*.5)*align).every(x=>x===(bits===8?128:0)));
  }
});
test('default merge and single chunk do not add pauses',()=> {
 const a=wav(32000);
 assert.equal(parseWav(combineAudioResults([a,a],'other').data).data.byteLength,40);
 assert.equal(combineAudioResults([a],'GPT-SoVITS',.5),a);
});
