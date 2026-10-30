// Offline audio-derived token timestamps. Invoked in a separate Node process,
// never inside Obsidian's UI process. No network calls or model downloads.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const MODEL = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';

function runtime() {
  const home = os.homedir();
  const roots = [path.join(__dirname, 'node_modules'),
    path.resolve(process.execPath, '../../lib/node_modules'),
    '/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules'];
  for (const base of [path.join(home, '.local/share/fnm/node-versions'), path.join(home, '.nvm/versions/node')]) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base).sort().reverse()) {
      roots.push(path.join(base, entry, 'installation/lib/node_modules'), path.join(base, entry, 'lib/node_modules'));
    }
  }
  let modulePath;
  for (const root of roots) {
    for (const candidate of [path.join(root, 'sherpa-onnx-node'), path.join(root, '@marswave/coli/node_modules/sherpa-onnx-node')]) {
      if (fs.existsSync(path.join(candidate, 'package.json'))) { modulePath = candidate; break; }
    }
    if (modulePath) break;
  }
  const modelDir = path.join(home, '.coli/models', MODEL);
  if (!modulePath || !fs.existsSync(path.join(modelDir, 'model.int8.onnx')) || !fs.existsSync(path.join(modelDir, 'tokens.txt'))) {
    throw new Error('缺少本地 SenseVoice 模型或 sherpa-onnx-node；请先安装离线对齐运行环境。');
  }
  const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(p => fs.existsSync(p)) || 'ffmpeg';
  return { modulePath, modelDir, ffmpeg };
}

function recognitionTokens(result, offset, keepStart, keepEnd, duration) {
  if (!Array.isArray(result.tokens) || result.tokens.length !== result.timestamps?.length) {
    throw new Error('识别引擎未返回逐词时间戳。');
  }
  const tokens = [];
  for (let i = 0; i < result.tokens.length; i++) {
    const text = result.tokens[i].replace(/▁/g, ' ').trim();
    const start = offset + result.timestamps[i];
    if (!text || /^<\|.*\|>$/.test(text) || !/[\p{L}\p{N}]/u.test(text)) continue;
    if (!Number.isFinite(start) || start < keepStart || start >= keepEnd || start >= duration) continue;
    // SenseVoice supplies CTC token starts. If it does not supply durations,
    // cap the final highlight at a short tail instead of counting silence as speech.
    const next = offset + result.timestamps[i + 1];
    const length = result.durations?.[i];
    const end = Math.min(duration, keepEnd, Number.isFinite(length) && length > 0 ? start + length
      : Number.isFinite(next) && next > start ? Math.min(next, start + .3) : start + .18);
    if (end > start) tokens.push({ text, start: +start.toFixed(4), end: +end.toFixed(4) });
  }
  return tokens;
}
async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function transcribe(audioPath) {
  const config = runtime();
  const before = await sha256(audioPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podvoice-timing-'));
  const pcm = path.join(dir, 'audio.f32');
  let child;
  const abort = () => { child?.kill('SIGTERM'); fs.rmSync(dir, { recursive: true, force: true }); process.exit(143); };
  process.once('SIGTERM', abort);
  try {
    await new Promise((resolve, reject) => {
      child = execFile(config.ffmpeg, ['-v', 'error', '-nostdin', '-i', audioPath, '-t', '7201', '-ar', '16000', '-ac', '1', '-f', 'f32le', '-y', pcm],
        { timeout: 180000, maxBuffer: 1024 * 1024 }, error => error ? reject(new Error('音频解码失败：' + error.message)) : resolve());
    });
    child = undefined;
    const duration = fs.statSync(pcm).size / 64000;
    if (!(duration > 0 && duration <= 7200)) throw new Error('当前离线对齐支持两小时以内的音频。');
    const onnx = require(config.modulePath);
    const recognizer = new onnx.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { senseVoice: { model: path.join(config.modelDir, 'model.int8.onnx'), useInverseTextNormalization: 0 },
        tokens: path.join(config.modelDir, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 },
    });
    const tokens = [];
    const fd = fs.openSync(pcm, 'r');
    try {
      for (let start = 0; start < duration; start += 30) {
        const end = Math.min(duration, start + 30);
        const from = Math.max(0, start - 2), to = Math.min(duration, end + 2);
        const bytes = Buffer.alloc(Math.round((to - from) * 16000) * 4);
        const read = fs.readSync(fd, bytes, 0, bytes.length, Math.round(from * 16000) * 4);
        const samples = new Float32Array(read / 4 + 6400);
        for (let i = 0; i < read / 4; i++) samples[i] = bytes.readFloatLE(i * 4);
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate: 16000, samples });
        recognizer.decode(stream);
        tokens.push(...recognitionTokens(recognizer.getResult(stream), from, start, end, duration));
        process.stderr.write(`对齐进度 ${Math.round(end)}/${Math.round(duration)} 秒\n`);
        await new Promise(resolve => setImmediate(resolve));
      }
    } finally { fs.closeSync(fd); }
    if (before !== await sha256(audioPath)) throw new Error('分析期间音频已被替换，请重新打开播放器。');
    if (!tokens.length) throw new Error('音频中没有识别到可对齐的语音。');
    return { version: 1, engine: 'sensevoice', audioSha256: before, duration, tokens };
  } finally {
    process.removeListener('SIGTERM', abort);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
if (require.main === module) {
  const audioPath = process.argv[2];
  if (!audioPath) { process.stderr.write('Usage: node speech-timing.cjs AUDIO\n'); process.exitCode = 1; }
  else transcribe(path.resolve(audioPath)).then(value => process.stdout.write(JSON.stringify(value)))
    .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
module.exports = { recognitionTokens, transcribe, runtime };
