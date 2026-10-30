const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');

// Exercise the plugin's actual cleanup pipeline without starting Obsidian.
const code = esbuild.transformSync(fs.readFileSync('main.ts', 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'es2018',
}).code;
const context = { module: { exports: {} }, console,
  require: (name) => {
    assert.equal(name, 'obsidian');
    return { Plugin: class {}, Modal: class {}, PluginSettingTab: class {} };
  },
};
vm.runInNewContext(code, context);
const plugin = new context.module.exports.default();
plugin.settings = {
  provider: 'volcengine', gptsovitsVoicePreset: 'mengyan_chat',
  stripMarkdown: true, skipLinePatterns: '', optimizeAcronyms: true,
  optimizeHyphens: true, addSpaceAfterPunctuation: true,
};

for (const value of ['3.14', '1,000', '10:30', '3.5%', 'v2.1.0', '1,234.56']) {
  test(`preserves numeric token ${value}`, () => {
    assert.equal(plugin.prepareText(`数据为${value}，请核对。`), `数据为${value}， 请核对。 `);
  });
}
test('still adds pauses around ordinary punctuation', () => {
  assert.equal(plugin.prepareText('你好，世界。Hello,world!'), '你好， 世界。 Hello, world! ');
});
test('can disable punctuation spacing', () => {
  plugin.settings.addSpaceAfterPunctuation = false;
  try { assert.equal(plugin.prepareText('价格3.14，明天10:30见。'), '价格3.14，明天10:30见。'); }
  finally { plugin.settings.addSpaceAfterPunctuation = true; }
});
test('local speech removes thousands separators before sentence splitting', () => {
  plugin.settings.provider = 'gptsovits';
  try {
    assert.equal(plugin.prepareText('金额1,000元，收入1,234.56元，总计12,345,678元。'),
      '金额1000元， 收入1234.56元， 总计12345678元。 ');
  } finally { plugin.settings.provider = 'volcengine'; }
});
test('local speech leaves non-grouped numeric lists unchanged', () => {
  plugin.settings.provider = 'gptsovits';
  try { assert.equal(plugin.prepareText('选项1,2,3，编号12,34。'), '选项1,2,3， 编号12,34。 '); }
  finally { plugin.settings.provider = 'volcengine'; }
});
test('local speech keeps the punctuation following a grouped amount', () => {
  plugin.settings.provider = 'gptsovits';
  try { assert.equal(plugin.prepareText('金额1,000,请核对。'), '金额1000, 请核对。 '); }
  finally { plugin.settings.provider = 'volcengine'; }
});

function localClockText(text) {
  const previous = { ...plugin.settings };
  plugin.settings.provider = 'gptsovits';
  plugin.settings.addSpaceAfterPunctuation = false;
  try { return plugin.prepareText(text); }
  finally { plugin.settings = previous; }
}

for (const [input, expected] of [
  ['会议从10:30开始。', '会议从十点半开始。'],
  ['今天是2026年10月29日，会议从10:30开始。', '今天是2026年10月29日，会议从十点半开始。'],
  ['明天10:30见。', '明天十点半见。'],
  ['上午 09:05 开会。', '上午 九点零五分 开会。'],
  ['闹钟设为07:00。', '闹钟设为七点整。'],
  ['开会时间：14：15。', '开会时间：十四点十五分。'],
  ['凌晨00:00出发。', '凌晨零点整出发。'],
  ['下午2:05集合。', '下午两点零五分集合。'],
  ['会议从10:30到11:45。', '会议从十点半到十一点四十五分。'],
  ['明天10:30—11:00开会。', '明天十点半—十一点整开会。'],
  ['会议定于23:59开始。', '会议定于二十三点五十九分开始。'],
  ['比例10:30。会议从10:30开始。', '比例10:30。会议从十点半开始。'],
]) {
  test(`reads an explicit clock time: ${input}`, () => assert.equal(localClockText(input), expected));
}

for (const input of [
  '10:30', '数据为10:30，请核对。', '比例10:30。', '配比为10:30。',
  '上午比赛比分10:30。', '会议讨论的比例为10:30。', '明天10:30这个比分会重现吗？',
  '画面宽高比16:09。', '双方战成10:30。', '现在领先10:30。',
  '视频从10:30开始。', '会议视频从10:30开始。', '上午的视频在10:30处暂停。',
  '会议从01:10:30开始。', '明天01：10：30开始。', '上午01: 10:30开始。',
  '会议从10:30:00开始。', '会议从10:30.500开始。',
  '会议从10:30,500开始。', '会议从10:30：00开始。', '跳到10:30开始播放。',
  '录音进度10:30。', '字幕时间码10:30。', '会议从24:00开始。',
  '会议从10:60开始。', '上午110:30开会。', '上午10:300开会。',
  '会议在 https://example.com/10:30 开始。', '北京时间：2026-10-29T10:30:00Z。',
]) {
  test(`does not reinterpret a ratio, score, timecode or ambiguous value: ${input}`,
    () => assert.equal(localClockText(input), input));
}

test('clock handling is local-provider only', () => {
  assert.equal(plugin.prepareText('会议从10:30开始。'), '会议从10:30开始。 ');
});
test('clock handling works with the full punctuation cleanup pipeline', () => {
  plugin.settings.provider = 'gptsovits';
  try {
    assert.equal(plugin.prepareText('会议从10:30开始，预算1,250.50元。'), '会议从十点半开始， 预算1250.50元。 ');
    assert.equal(plugin.prepareText('比分10：30，时间码01：10：30。'), '比分10：30， 时间码01：10：30。 ');
  } finally { plugin.settings.provider = 'volcengine'; }
});

for (const [input, expected] of [
  ['500 年前，或者 500 年后的未来。', '五百年前，或者 五百年后的未来。'],
  ['275 年前，11 年后，101 年以前。', '二百七十五年前，十一年后，一百零一年以前。'],
  ['2009 年末，1962 年，1939 年和1945 年。', '2009 年末，1962 年，1939 年和1945 年。'],
  ['编号A500 年后，版本2.500 年后。', '编号A500 年后，版本2.500 年后。'],
  ['500 年后的未来。', '五百年后的未来。'],
]) test(`local narration boundary: ${input}`, () => assert.equal(localClockText(input), expected));

test('book-title closing mark still gets a line-end pause', () => {
  const previous = { ...plugin.settings };
  Object.assign(plugin.settings, {provider:'gptsovits', includeTitleInAudio:true, addPauseAtLineBreaks:true, addSpaceAfterPunctuation:false});
  try {
    assert.equal(plugin.prepareText('# 27 我的新书《一如既往》\n\n**巴菲特的糖果之谜：在瞬息万变的世界里，抓住永恒不变的东西**'),
      '27 我的新书《一如既往》。\n\n巴菲特的糖果之谜：在瞬息万变的世界里，抓住永恒不变的东西。');
    assert.match(plugin.prepareText('正文。', '27 我的新书《一如既往》'), /^27 我的新书《一如既往》。/);
    assert.equal(plugin.prepareText('他说：“说完了。”\n下一行'), '他说：“说完了。”\n下一行。');
  } finally { plugin.settings = previous; }
});

for (const stripMarkdown of [true, false]) {
  for (const escaped of [true, false]) {
    test(`reads list numbers with a pause (escaped=${escaped}, stripMarkdown=${stripMarkdown})`, () => {
      const previous = { ...plugin.settings };
      Object.assign(plugin.settings, { provider: 'gptsovits', stripMarkdown });
      const items = ['你认为好消息会永远持续。', '你开始对坏消息视而不见。',
        '你忽视坏消息。', '你否认坏消息。', '你因坏消息而恐慌。', '你接受坏消息。',
        '你认为坏消息会永远持续。', '你开始对好消息视而不见…'];
      const source = items.map((text, i) => `${i + 1}${escaped ? '\\' : ''}. ${text}`).join('\n\n');
      try {
        const result = plugin.prepareText(source);
        assert.equal(result, items.map((text, i) => `${i + 1}、 ${text}`).join('\n\n'));
        assert.equal(plugin.getGenerationChunks(result, 1200, 'gptsovits').length, 8);
      } finally { plugin.settings = previous; }
    });
  }
}

test('cleans quoted and emphasized list numbers after their Markdown wrappers', () => {
  assert.equal(plugin.prepareText('> **10\\.** 内容。\n\n  11. 内容。'), '10、 内容。\n\n  11、 内容。 ');
});

test('list cleanup preserves decimals, versions and line boundaries', () => {
  const input = '0.1 是小数。\n3.14 是圆周率。\n1.2.3 是版本。\n1.\n下一行。';
  assert.equal(plugin.prepareText(input), '0.1 是小数。\n3.14 是圆周率。\n1.2.3 是版本。\n1.\n下一行。 ');
});
