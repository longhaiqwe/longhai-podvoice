const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

test('standard community assets contain a runnable alignment worker without a separate script', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'podvoice-install-'));
  const pluginDir = path.join(root, '.obsidian/plugins/longhai-podvoice');
  fs.mkdirSync(pluginDir, { recursive: true });
  for (const name of ['main.js', 'manifest.json', 'styles.css']) {
    fs.copyFileSync(name, path.join(pluginDir, name));
  }
  let invocation;
  let source;
  const audio = new TextEncoder().encode('fixture audio').buffer;
  const digest = require('node:crypto').createHash('sha256').update(new Uint8Array(audio)).digest('hex');
  const timing = { version: 1, engine: 'sensevoice', audioSha256: digest, duration: 2,
    tokens: [{ text: '你好', start: 0.2, end: 1 }] };
  const child = { stdin: {
    on() {},
    end(value) { source = value; queueMicrotask(() => invocation.callback(null, JSON.stringify(timing), '')); },
  } };
  const context = { module: { exports: {} }, console, process,
    require(name) {
      if (name === 'obsidian') return { Plugin: class {}, Modal: class {}, PluginSettingTab: class {} };
      if (name === 'child_process') return { execFile(node, args, options, callback) {
        invocation = { node, args, options, callback }; return child;
      } };
      return require(name);
    },
  };
  try {
    vm.runInNewContext(fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8'), context);
    const plugin = new context.module.exports.default();
    plugin.manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
    let cache;
    plugin.app = { vault: { configDir: '.obsidian', readBinary: async () => audio,
      adapter: { getBasePath: () => root, read: async () => { throw new Error('no cache'); },
        write: async (_, data) => { cache = JSON.parse(data); } } } };
    await plugin.getSpeechTiming({ path: 'audio with spaces.wav' });
    assert.equal(invocation.args[0], '-');
    assert.equal(invocation.args[1], path.join(root, 'audio with spaces.wav'));
    assert.equal(invocation.options.cwd, pluginDir);
    assert.equal(cache.audioSha256, digest);
    assert.equal(fs.existsSync(path.join(pluginDir, 'speech-timing.cjs')), false);
    const run = spawnSync(process.execPath, ['-'], { input: source, cwd: pluginDir, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Usage: node speech-timing.cjs AUDIO/);
    assert.doesNotMatch(run.stderr, /MODULE_NOT_FOUND|SyntaxError/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
