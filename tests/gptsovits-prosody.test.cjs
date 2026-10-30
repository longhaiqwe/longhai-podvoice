const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), vm = require('node:vm'), esbuild = require('esbuild');
const requests=[];
const context={module:{exports:{}},console,require:()=>({Plugin:class{},Modal:class{},PluginSettingTab:class{},
 requestUrl:async req=>{requests.push(req);return {status:200,headers:{'content-type':'audio/wav'},arrayBuffer:new Uint8Array([1,2,3]).buffer};}
})};
vm.runInNewContext(esbuild.transformSync(fs.readFileSync('main.ts','utf8'),{loader:'ts',format:'cjs',target:'es2018'}).code,context);
for (const voice of ['liufei_acoustic_candidate', 'mengyan_acoustic_candidate']) {
test(`${voice} isolates acoustic sentences without overriding the selected pace or sampling`,async()=>{
 requests.length=0;
 const p=new context.module.exports.default();
 p.settings={gptsovitsEndpoint:'http://127.0.0.1:9880/tts',gptsovitsVoicePreset:voice,gptsovitsSpeed:1.1,gptsovitsTemperature:.68,gptsovitsTopP:.9,gptsovitsTopK:12};
 const before=JSON.stringify(p.settings);
 await p.requestGptSoVitsAudio('第一句。第二句。');
 const payload=JSON.parse(requests.find(r=>r.method==='POST').body);
 assert.equal(payload.independent_decode,true);
 assert.equal(payload.speed_factor,1.1);
 assert.equal(payload.temperature,.68);
 assert.equal(payload.top_p,.9);
 assert.equal(payload.top_k,12);
 assert.equal(payload.batch_size,2);
 assert.equal(payload.parallel_infer,true);
 assert.equal(JSON.stringify(p.settings),before);
});
}
