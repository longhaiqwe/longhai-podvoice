const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');
const context = { module: { exports: {} }, console,
  require: () => ({ Plugin: class {}, Modal: class {}, PluginSettingTab: class {} }) };
vm.runInNewContext(esbuild.transformSync(fs.readFileSync('main.ts', 'utf8') + `
module.exports.payload = renderJsonTemplate;
module.exports.headers = renderHeaderTemplate;
module.exports.message = errorMessage;
module.exports.lookup = getByPath;`, { loader: 'ts', format: 'cjs' }).code, context);
const api = context.module.exports;

test('custom payload preserves nested values and escapes selected note text', () => {
  const value = api.payload('{"text":"{{text}}","options":{"speed":1.2}}', '中文 "quote"\nnext');
  assert.equal(value.text, '中文 "quote"\nnext');
  assert.equal(value.options.speed, 1.2);
  for (const invalid of ['null', '[]', '12', '"text"']) assert.throws(() => api.payload(invalid, ''));
});
test('custom headers reject non-string values before a request is sent', () => {
  assert.equal(api.headers('{"Authorization":"Bearer example"}', '').Authorization, 'Bearer example');
  for (const value of ['null', '2', '{}', '[]']) assert.throws(() => api.headers(`{"Authorization":${value}}`, ''));
});
test('provider errors always yield readable text even when fields are objects', () => {
  assert.equal(api.message({ message: 'HTTP', json: { message: '服务不可用' } }), 'HTTP：服务不可用');
  assert.equal(api.message({ text: '{"error":"失败"}' }), '请求失败：失败');
  assert.equal(api.message({ message: { unexpected: true } }), '[object Object]');
});
test('custom response lookup tolerates missing and malformed intermediate fields', () => {
  assert.equal(api.lookup({ data: { audio: 'https://example.test/audio.mp3' } }, 'data.audio'), 'https://example.test/audio.mp3');
  for (const value of [null, false, 1, { data: null }, { data: 'invalid' }]) {
    assert.equal(api.lookup(value, 'data.audio'), undefined);
  }
});
