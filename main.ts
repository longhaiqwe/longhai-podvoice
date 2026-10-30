import {
  addIcon,
  setIcon,
  App,
  Editor,
  FileSystemAdapter,
  Menu,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  sanitizeHTMLToDom,
  Setting,
  TFile,
  TFolder,
} from "obsidian";

// Embedded at build time; community installs only main.js, manifest.json and styles.css.
declare const PODVOICE_SPEECH_TIMING_SOURCE: string;

interface ProviderTaskResponse {
  task_id?: string; status_url?: string; status?: string; vault_path?: string;
  audio_url?: string; m4a_bytes?: number; audio_bytes?: number; error?: string;
}
interface ReplicatePrediction {
  urls?: { get?: string }; status?: string; error?: string; output?: unknown;
}
interface StoredPluginData extends Partial<NoteTtsSettings> {
  gptsovitsPreferredPresets?: unknown;
  batchPauseState?: { resumeAt: number | null; folderPath: string };
  pendingTasks?: PendingTtsTask[];
  noteContentHashes?: Record<string, string>;
}

type ProviderId = "volcengine" | "minimax" | "replicate" | "gptsovits" | "custom";
type SettingsLanguage = "auto" | "zh" | "en";
type AudioChunkListener = (audio: AudioResult, index: number, count: number) => void;

const REPLICATE_MINIMAX_MODEL = "minimax/speech-2.8-turbo";
const REPLICATE_CUSTOM_VOICE = "custom";
const NOTE_TTS_NOTE_ICON = "headphones";
const NOTE_TTS_SELECTION_ICON = "note-tts-selection";
const NOTE_TTS_PREVIEW_ICON = "note-tts-preview";

const NOTE_TTS_SELECTION_ICON_SVG = `
<path d="M14 22h52" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round"/>
<path d="M40 22v50" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round"/>
<path d="M24 72h32" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round"/>
<path d="M66 38v40l28-20z" fill="currentColor"/>
`;

const NOTE_TTS_PREVIEW_ICON_SVG = `
<path d="M10 50c12-20 25-30 40-30s28 10 40 30c-12 20-25 30-40 30S22 70 10 50z" fill="none" stroke="currentColor" stroke-width="9" stroke-linejoin="round"/>
<circle cx="50" cy="50" r="13" fill="none" stroke="currentColor" stroke-width="9"/>
`;

const MOWEN_LISTEN_ICON_SVG = `
<svg class="podvoice-mowen-svg" viewBox="0 0 24 24" fill="none">
  <!-- 耳机头梁与左右耳罩 -->
  <path d="M4.5 12V9.5a7.5 7.5 0 0 1 15 0V12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  <rect x="3" y="11" width="3" height="6.5" rx="1.5" fill="currentColor"/>
  <rect x="18" y="11" width="3" height="6.5" rx="1.5" fill="currentColor"/>
  <!-- 内部精致 Ai 字样 -->
  <path d="M8.2 16L10.3 9.8h0.8l2.1 6.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M9 14.3h2.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  <path d="M15.2 12.2v3.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  <circle cx="15.2" cy="10.2" r="0.85" fill="currentColor"/>
  <!-- 莫问同款小绿勾徽标 (已生成状态展示) -->
  <g class="podvoice-badge-check">
    <circle cx="18" cy="18" r="4.6" fill="#22c55e" stroke="var(--background-primary, #ffffff)" stroke-width="1.2"/>
    <path d="M16 18l1.3 1.3 2.7 -2.8" fill="none" stroke="#ffffff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>
`;

const VOLCENGINE_VOICES = [
  { id: "BV001_streaming", name: "⭐ 墨问同款·知性女声 (BV001 默认推荐)" },
  { id: "BV002_streaming", name: "⭐ 墨问同款·磁性男声 (BV002 沉稳耐听)" },
  { id: "BV700_streaming", name: "豆包爆款·灿灿 (BV700 阳光亲切女声)" },
  { id: "BV119_streaming", name: "新闻纪实·沉稳男声 (BV119 播音腔)" },
  { id: "custom", name: "自定义音色代码 (手动输入其他音色)" },
];

const REPLICATE_MINIMAX_VOICES = [
  "Wise_Woman",
  "Friendly_Person",
  "Inspirational_girl",
  "Deep_Voice_Man",
  "Calm_Woman",
  "Casual_Guy",
  "Lively_Girl",
  "Patient_Man",
  "Young_Knight",
  "Determined_Man",
  "Lovely_Girl",
  "Decent_Boy",
  "Imposing_Manner",
  "Elegant_Man",
  "Abbess",
  "Sweet_Girl_2",
  "Exuberant_Girl",
];

const GPTSOVITS_VOICES = [
  { id: "liufei_acoustic_candidate", name: "刘飞" },
  { id: "mengyan_acoustic_candidate", name: "孟岩" },
  { id: "custom", name: "自定义音色" },
] as const;

type GptSoVitsVoicePreset = typeof GPTSOVITS_VOICES[number]["id"];

function normalizeGptSoVitsVoicePreset(value: unknown): GptSoVitsVoicePreset {
  if (value === "custom") return "custom";
  if (value === "mengyan_chat" || value === "mengyan_intro" || value === "mengyan_acoustic_candidate") {
    return "mengyan_acoustic_candidate";
  }
  return "liufei_acoustic_candidate";
}

type VoiceSettingKey = "volcengineVoiceType" | "gptsovitsVoicePreset" | "minimaxVoiceId" | "replicateVoiceId";

interface VoiceMenuOption {
  id: string;
  name: string;
  key: VoiceSettingKey;
  unavailable: string;
}

interface NoteTtsSettings {
  settingsLanguage: SettingsLanguage;
  textCleanupMode?: "recommended" | "custom";
  provider: ProviderId;
  outputFolder: string;
  maxCharacters: number;
  chunkCharacters: number;
  includeTitleInAudio: boolean;
  stripMarkdown: boolean;
  removeFrontmatter: boolean;
  removeTags: boolean;
  removeLinks: boolean;
  removeUrls: boolean;
  removeEmbeds: boolean;
  removeHtmlComments: boolean;
  skipLinePatterns: string;
  optimizeAcronyms: boolean;
  optimizeHyphens: boolean;
  addPauseAtLineBreaks: boolean;
  lineBreakPauseType: "period" | "comma";
  addSpaceAfterPunctuation: boolean;
  volcengineAppId: string;
  volcengineAccessToken: string;
  volcengineCluster: string;
  volcengineVoiceType: string;
  volcengineCustomVoiceType: string;
  volcengineEndpoint: string;
  volcengineSpeed: number;
  volcengineVolume: number;
  volcenginePitch: number;
  keepOnlyLatestAudio: boolean;
  audioNamingMode: "clean" | "timestamp";
  associateNoteFrontmatter: boolean;
  frontmatterKey: string;
  autoEmbedInNote: "none" | "top" | "bottom";
  autoOpenPlayerAfterGenerate: boolean;
  showTitleInlineButton: boolean;
  titleButtonPosition: "right" | "top" | "bottom";
  showPodcastCard: boolean;
  podcastCardTitle: string;
  enableFloatingPlayer: boolean;
  enableSentenceHighlight: boolean;
  enableSpeechAlignment: boolean;
  enableAutoScroll: boolean;
  highlightLeadTime: number;
  minimaxApiKey: string;
  minimaxModel: string;
  minimaxVoiceId: string;
  minimaxLanguageBoost: string;
  minimaxEndpoint: string;
  minimaxSpeed: number;
  minimaxVolume: number;
  minimaxPitch: number;
  replicateApiToken: string;
  replicateModel: string;
  replicateVersion: string;
  replicateInputTemplate: string;
  replicateVoiceId: string;
  replicateCustomVoiceId: string;
  replicateLanguageBoost: string;
  replicateEmotion: string;
  replicateSpeed: number;
  replicateVolume: number;
  replicatePitch: number;
  customEndpoint: string;
  customMethod: string;
  customHeaders: string;
  customBodyTemplate: string;
  customChunkCharacters: number;
  customAudioUrlPath: string;
  customAudioHexPath: string;
  customAudioBase64Path: string;
  gptsovitsEndpoint: string;
  gptsovitsVoicePreset: GptSoVitsVoicePreset;
  gptsovitsCustomRefAudio: string;
  gptsovitsCustomPromptText: string;
  gptsovitsCustomPromptLang: string;
  gptsovitsSpeed: number;
  gptsovitsTemperature: number;
  gptsovitsTopP: number;
  gptsovitsTopK: number;
  batchSyncFolder: string;
  batchIncludeSubfolders: boolean;
  batchSkipUnmodified: boolean;
  batchScheduleEnabled: boolean;
  batchScheduleTime: string;
  batchCatchUpOnStartup: boolean;
  lastBatchSyncDate: string;
}

// Only these rules belong to the cleanup preset; title, chunking and provider values stay independent.
const TEXT_CLEANUP_KEYS = [
  "stripMarkdown", "removeFrontmatter", "removeTags", "removeLinks", "removeUrls",
  "removeEmbeds", "removeHtmlComments", "skipLinePatterns", "optimizeAcronyms",
  "optimizeHyphens", "addPauseAtLineBreaks", "lineBreakPauseType", "addSpaceAfterPunctuation",
] as const;

const DEFAULT_SETTINGS: NoteTtsSettings = {
  settingsLanguage: "auto",
  provider: "volcengine",
  volcengineAppId: "",
  volcengineAccessToken: "",
  volcengineCluster: "volcano_tts",
  volcengineVoiceType: "BV001_streaming",
  volcengineCustomVoiceType: "",
  volcengineEndpoint: "https://openspeech.bytedance.com/api/v1/tts",
  volcengineSpeed: 1,
  volcengineVolume: 1,
  volcenginePitch: 1,
  associateNoteFrontmatter: true,
  frontmatterKey: "audio",
  autoEmbedInNote: "none",
  autoOpenPlayerAfterGenerate: false,
  showTitleInlineButton: true,
  titleButtonPosition: "right",
  showPodcastCard: true,
  podcastCardTitle: "收听播客",
  enableFloatingPlayer: true,
  enableSentenceHighlight: true,
  enableSpeechAlignment: true,
  enableAutoScroll: true,
  highlightLeadTime: 0,
  keepOnlyLatestAudio: true,
  audioNamingMode: "clean",

  outputFolder: "TTS Audio",
  maxCharacters: 10000,
  chunkCharacters: 1200,
  includeTitleInAudio: true,
  stripMarkdown: true,
  removeFrontmatter: true,
  removeTags: true,
  removeLinks: true,
  removeUrls: true,
  removeEmbeds: true,
  removeHtmlComments: true,
  skipLinePatterns: [
    "^\\*\\*来源链接：\\*\\*$",
    "^来源链接：?$",
    "^\\[?推文\\d*\\]?$",
    "^\\[?[^\\]]+推文\\d*\\]?$",
    "^(?:[^,，、\\n]*推文\\d+\\s*[,，、]?\\s*)+$",
    "^---$",
  ].join("\n"),
  optimizeAcronyms: true,
  optimizeHyphens: true,
  addPauseAtLineBreaks: true,
  lineBreakPauseType: "period",
  addSpaceAfterPunctuation: true,
  minimaxApiKey: "",
  minimaxModel: "speech-2.8-turbo",
  minimaxVoiceId: "Chinese_Mandarin_Gentleman",
  minimaxLanguageBoost: "auto",
  minimaxEndpoint: "https://api.minimax.io/v1/t2a_v2",
  minimaxSpeed: 1,
  minimaxVolume: 1,
  minimaxPitch: 0,
  replicateApiToken: "",
  replicateModel: REPLICATE_MINIMAX_MODEL,
  replicateVersion: "",
  replicateInputTemplate: "{\n  \"text\": \"{{text}}\"\n}",
  replicateVoiceId: "Wise_Woman",
  replicateCustomVoiceId: "",
  replicateLanguageBoost: "None",
  replicateEmotion: "auto",
  replicateSpeed: 1,
  replicateVolume: 1,
  replicatePitch: 0,
  customEndpoint: "",
  customMethod: "POST",
  customHeaders: "{\n  \"Content-Type\": \"application/json\"\n}",
  customBodyTemplate: "{\n  \"text\": \"{{text}}\"\n}",
  customChunkCharacters: 0,
  customAudioUrlPath: "audio_url",
  customAudioHexPath: "",
  customAudioBase64Path: "",
  gptsovitsEndpoint: "http://127.0.0.1:9880/tts",
  gptsovitsVoicePreset: "liufei_acoustic_candidate",
  gptsovitsCustomRefAudio: "",
  gptsovitsCustomPromptText: "",
  gptsovitsCustomPromptLang: "zh",
  gptsovitsSpeed: 1,
  gptsovitsTemperature: 0.82,
  gptsovitsTopP: 0.95,
  gptsovitsTopK: 15,
  batchSyncFolder: "",
  batchIncludeSubfolders: true,
  batchSkipUnmodified: true,
  batchScheduleEnabled: false,
  batchScheduleTime: "00:00",
  batchCatchUpOnStartup: true,
  lastBatchSyncDate: "",
};

interface AudioResult {
  data?: ArrayBuffer;
  extension: string;
  mimeType: string;
  vaultPath?: string;
}

interface GenerationLog {
  version: 1;
  id: string;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  durationMs: number;
  durationBasis: "monotonic" | "wall-clock";
  status: "running" | "success" | "failed" | "pending";
  mode: "note" | "selection" | "batch" | "preview";
  sourcePath?: string;
  outputPath?: string;
  provider: ProviderId;
  model: string;
  voiceId: string;
  voiceName: string;
  modelWeights?: { gpt: string; sovits: string };
  referenceAudio?: string;
  characterCount: number;
  chunkCount: number;
  error?: string;
}

interface GenerationTask {
  kind: "manual" | "batch";
  path?: string;
  logId?: string;
  settings?: NoteTtsSettings;
}

class BatchSupersededError extends Error {
  constructor() { super("暂停期间该笔记已手动生成，跳过旧批量结果。"); this.name = "BatchSupersededError"; }
}

interface PendingTtsTask {
  id: string;
  sourcePath: string;
  statusUrl: string;
  audioUrl?: string;
  headers: Record<string, string>;
  created: number;
  textLength: number;
  generationLog?: GenerationLog;
}

class PendingTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingTaskError";
  }
}

type SettingsTextKey =
  | "volcengineAppIdDesc"
  | "volcengineAccessTokenDesc"
  | "volcengineClusterDesc"
  | "volcengineVoiceDesc"
  | "volcengineCustomVoiceDesc"
  | "volcengineSpeedDesc"
  | "volcengineVolumeDesc"
  | "volcenginePitchDesc"
  | "storageHeading"
  | "storageStatsDesc"
  | "keepOnlyLatestAudioName"
  | "keepOnlyLatestAudioDesc"
  | "cleanOrphansBtn"
  | "clearAllAudiosBtn"
  | "clearAllConfirm"
  | "noteAssociationHeading"
  | "associateNoteFrontmatterName"
  | "associateNoteFrontmatterDesc"
  | "frontmatterKeyName"
  | "frontmatterKeyDesc"
  | "autoEmbedInNoteName"
  | "autoEmbedInNoteDesc"
  | "autoEmbedNone"
  | "autoEmbedTop"
  | "autoEmbedBottom"
  | "autoOpenPlayerAfterGenerateName"
  | "autoOpenPlayerAfterGenerateDesc"
  | "showTitleInlineButtonName"
  | "showTitleInlineButtonDesc"
  | "titleButtonPositionName"
  | "titleButtonPositionDesc"
  | "posRight"
  | "posTop"
  | "posBottom"
  | "showPodcastCardName"
  | "showPodcastCardDesc"
  | "podcastCardTitleName"
  | "podcastCardTitleDesc"
  | "enableFloatingPlayerName"
  | "enableFloatingPlayerDesc"
  | "enableSentenceHighlightName"
  | "enableSentenceHighlightDesc"
  | "enableAutoScrollName"
  | "enableAutoScrollDesc"
  | "highlightLeadTimeName"
  | "highlightLeadTimeDesc"
  | "testVolcengineButton"
  | "testVolcengineDesc"
  | "settingsLanguageName"
  | "settingsLanguageDesc"
  | "settingsLanguageAuto"
  | "settingsLanguageZh"
  | "settingsLanguageEn"
  | "providerDesc"
  | "outputFolderName"
  | "outputFolderDesc"
  | "maxCharactersName"
  | "maxCharactersDesc"
  | "chunkCharactersName"
  | "chunkCharactersDesc"
  | "stripMarkdownName"
  | "stripMarkdownDesc"
  | "textCleanupHeading"
  | "removeFrontmatterName"
  | "removeFrontmatterDesc"
  | "removeTagsName"
  | "removeTagsDesc"
  | "removeLinksName"
  | "removeLinksDesc"
  | "removeUrlsName"
  | "removeUrlsDesc"
  | "removeEmbedsName"
  | "removeEmbedsDesc"
  | "removeHtmlCommentsName"
  | "removeHtmlCommentsDesc"
  | "skipLinePatternsName"
  | "skipLinePatternsDesc"
  | "voiceOptimizationHeading"
  | "includeTitleInAudioName"
  | "includeTitleInAudioDesc"
  | "optimizeAcronymsName"
  | "optimizeAcronymsDesc"
  | "optimizeHyphensName"
  | "optimizeHyphensDesc"
  | "addPauseAtLineBreaksName"
  | "addPauseAtLineBreaksDesc"
  | "lineBreakPauseTypeName"
  | "lineBreakPauseTypeDesc"
  | "lineBreakPausePeriod"
  | "lineBreakPauseComma"
  | "addSpaceAfterPunctuationName"
  | "addSpaceAfterPunctuationDesc"
  | "minimaxApiKeyDesc"
  | "minimaxEndpointDesc"
  | "minimaxModelDesc"
  | "minimaxVoiceIdDesc"
  | "minimaxLanguageBoostDesc"
  | "speedDesc"
  | "volumeDesc"
  | "pitchDesc"
  | "replicateApiTokenDesc"
  | "replicateModelDesc"
  | "replicateVoiceDesc"
  | "replicateCustomVoiceIdDesc"
  | "replicateLanguagePreferenceDesc"
  | "replicateEmotionDesc"
  | "replicateSpeedDesc"
  | "replicateVolumeDesc"
  | "replicatePitchDesc"
  | "advancedReplicateHeading"
  | "replicateVersionDesc"
  | "replicateInputTemplateDesc"
  | "customEndpointDesc"
  | "customMethodDesc"
  | "customHeadersDesc"
  | "customBodyTemplateDesc"
  | "customChunkCharactersDesc"
  | "customAudioUrlPathDesc"
  | "customAudioHexPathDesc"
  | "customAudioBase64PathDesc"
  | "gptsovitsEndpointName"
  | "gptsovitsEndpointDesc"
  | "gptsovitsVoicePresetName"
  | "gptsovitsVoicePresetDesc"
  | "gptsovitsCustomRefAudioName"
  | "gptsovitsCustomRefAudioDesc"
  | "gptsovitsCustomPromptTextName"
  | "gptsovitsCustomPromptTextDesc"
  | "gptsovitsSpeedName"
  | "gptsovitsSpeedDesc"
  | "gptsovitsTemperatureName"
  | "gptsovitsTemperatureDesc"
  | "testGptSoVitsButton"
  | "testGptSoVitsDesc";

const SETTINGS_TEXT: Record<"zh" | "en", Record<SettingsTextKey, string>> = {
  zh: {
    settingsLanguageName: "设置页语言",
    settingsLanguageDesc: "选择设置页语言。Auto 模式会自动跟随 Obsidian 的语言设置（当前已识别为中文）。",
    settingsLanguageAuto: "Auto (自动跟随软件语言)",
    settingsLanguageZh: "中文",
    settingsLanguageEn: "English",
    providerDesc: "选择用哪个 API 生成语音。",
    outputFolderName: "输出文件夹",
    outputFolderDesc: "生成的 MP3 会保存到 vault 中的这个文件夹。",
    maxCharactersName: "最大字符数",
    maxCharactersDesc: "避免把特别长的笔记误发给同步 API。",
    chunkCharactersName: "分段字符数",
    chunkCharactersDesc: "填 0 可关闭分段。本地 GPT-SoVITS 按自然段生成，首包约 80 字、后续约 160 字，长句沿标点拆分；此处更大的值不会把自然段重新拼包。其他服务按此字符上限分段。",
    stripMarkdownName: "转换前清理 Markdown",
    stripMarkdownDesc: "移除代码块、链接语法和常见 Markdown 标记。",
    textCleanupHeading: "文本清理",
    removeFrontmatterName: "移除 YAML/frontmatter",
    removeFrontmatterDesc: "跳过笔记顶部的 date、type、tags 等元数据。",
    removeTagsName: "移除标签",
    removeTagsDesc: "跳过 #tag 和 tags: 字段。",
    removeLinksName: "移除链接地址",
    removeLinksDesc: "保留链接文字，但不朗读 URL。",
    removeUrlsName: "移除裸 URL",
    removeUrlsDesc: "跳过直接写在正文里的 https:// 链接。",
    removeEmbedsName: "移除图片和嵌入",
    removeEmbedsDesc: "跳过 Markdown 图片与 Obsidian 嵌入。",
    removeHtmlCommentsName: "移除 HTML 注释",
    removeHtmlCommentsDesc: "跳过 <!-- comment --> 内容。",
    skipLinePatternsName: "跳过整行的规则",
    skipLinePatternsDesc: "每行一个正则表达式。匹配到的整行不会送去生成语音。",
    voiceOptimizationHeading: "语音与朗读优化",
    includeTitleInAudioName: "朗读笔记标题",
    includeTitleInAudioDesc: "朗读整篇笔记时，自动将笔记标题加入语音开头。若正文开头已有相同标题则智能去重，避免重复朗读。",
    optimizeAcronymsName: "优化英文缩写朗读",
    optimizeAcronymsDesc: "在连续大写字母（如 SDK、API）之间自动插入空格，防止被读成单个单词或连读。",
    optimizeHyphensName: "优化连字符与破折号朗读",
    optimizeHyphensDesc: "中文字词间的连字符（如“根-干-枝-叶”、“端-到-端”）消音连读，防止误读成“减”；规范化英文连词符与破折号停顿。",
    addPauseAtLineBreaksName: "行尾自动添加停顿",
    addPauseAtLineBreaksDesc: "如果行尾没有标点符号（如标题、列表项），自动添加停顿符号，避免朗读时与下一行内容连在一起。",
    lineBreakPauseTypeName: "行尾停顿符号",
    lineBreakPauseTypeDesc: "选择在没有标点符号的行尾添加句号（停顿较长）还是逗号（停顿较短）。",
    lineBreakPausePeriod: "句号 。",
    lineBreakPauseComma: "逗号 ，",
    addSpaceAfterPunctuationName: "标点符号后添加空格",
    addSpaceAfterPunctuationDesc: "在所有标点符号（如逗号、句号、分号、问号、感叹号、冒号、顿号等）后自动加上空格，帮助 TTS 语音在标点处发出更自然的短停顿。",
    volcengineAppIdDesc: "在火山引擎控制台语音技术获取的 App ID。",
    volcengineAccessTokenDesc: "在火山引擎控制台创建的 Access Token 或 API Key。",
    volcengineClusterDesc: "默认使用 volcano_tts。",
    volcengineVoiceDesc: "预置了墨问/剪映同款热门音色，也可选自定义输入代码。",
    volcengineCustomVoiceDesc: "自定义 Voice Type 代码，如 BV001_streaming 等。",
    volcengineSpeedDesc: "语速倍率，常用范围 0.5–2.0，默认 1.0。",
    volcengineVolumeDesc: "音量倍率，推荐 1.0 (范围 0.1 ~ 3.0)。",
    volcenginePitchDesc: "音调倍率，推荐 1.0 (范围 0.1 ~ 3.0)。",
    storageHeading: "存储空间与缓存管理 (防膨胀)",
    storageStatsDesc: "统计当前本地 Vault 中保存的音频文件及占用容量。",
    keepOnlyLatestAudioName: "单笔记覆盖模式 (防无限增加)",
    keepOnlyLatestAudioDesc: "同一篇笔记重新生成语音时，直接覆盖/替换旧音频，不无限生成多份历史文件，节省磁盘与 iCloud 同步空间。",
    cleanOrphansBtn: "清理孤立音频 (无对应笔记)",
    clearAllAudiosBtn: "一键清空所有生成的音频",
    clearAllConfirm: "确定要清空 TTS Audio 目录下的所有音频吗？笔记文本不会受到任何影响。",
    noteAssociationHeading: "笔记与音频双向关联",
    associateNoteFrontmatterName: "在笔记属性中记录音频",
    associateNoteFrontmatterDesc: "生成音频后，自动在当前笔记的 YAML 属性中记录音频链接 (如 audio: [[TTS Audio/xxx.mp3]])。",
    frontmatterKeyName: "音频属性名",
    frontmatterKeyDesc: "用于记录音频链接的 YAML 属性名，默认 audio。",
    autoEmbedInNoteName: "插入音频播放器",
    autoEmbedInNoteDesc: "是否在笔记中插入 ![[...]] 语法，方便在笔记内直接出现播放器。",
    autoEmbedNone: "不插入",
    autoEmbedTop: "插入到笔记顶部",
    autoEmbedBottom: "插入到笔记底部",
    autoOpenPlayerAfterGenerateName: "生成后自动弹出播放器",
    autoOpenPlayerAfterGenerateDesc: "是否在完整音频保存后自动弹出播放面板。本地多段手动生成会提前提供播放器，完成时不重复弹窗；此开关不控制提前播放。",
    showTitleInlineButtonName: "显示「听全文」按钮",
    showTitleInlineButtonDesc: "在文章标题旁显示精致的「🎧Ai 听全文」胶囊按钮。点击后台生成，生成好后出现绿勾，未修改文章直接播放。",
    titleButtonPositionName: "按钮位置",
    titleButtonPositionDesc: "选择「听全文」胶囊按钮在文章中的挂载位置。",
    posRight: "标题右侧",
    posTop: "标题上方",
    posBottom: "标题下方",
    showPodcastCardName: "正文顶部显示音频播放条",
    showPodcastCardDesc: "在笔记标题下方自动显示精致纯粹的音频播放条，无需弹出窗口，直接在正文中播放与收听。",
    podcastCardTitleName: "播客卡片标题",
    podcastCardTitleDesc: "卡片顶部显示的标题文字，默认为「收听播客」。",
    enableFloatingPlayerName: "浮动播放器",
    enableFloatingPlayerDesc: "在屏幕下方悬浮现代毛玻璃控制坞。长文下滑阅读时始终触手可及，随手暂停/恢复，支持进度拖拽、倍速与折叠。",
    enableSentenceHighlightName: "逐句高亮",
    enableSentenceHighlightDesc: "优先使用本地语音识别得到的句子时间；无法对齐时显示估算状态。",
    enableAutoScrollName: "跟随朗读滚动",
    enableAutoScrollDesc: "语音朗读时，页面自动平滑滚动并将当前朗读的句子居中在视线舒适区，无需手动滑屏。",
    highlightLeadTimeName: "高亮同步",
    highlightLeadTimeDesc: "仅用于估算高亮；语音对齐成功后自动忽略此值。估算太快选延后、太慢选提前，默认不偏移。单位为当前倍速下的实际秒数，适用于所有笔记。",
    testVolcengineButton: "测试火山引擎音色",
    testVolcengineDesc: "发送一句测试文本以验证 AppID、Token 与音色是否配置成功。",
    minimaxApiKeyDesc: "Bearer token。",
    minimaxEndpointDesc: "默认使用 HTTP T2A。",
    minimaxModelDesc: "例如 speech-2.8-turbo 或 speech-2.8-hd。",
    minimaxVoiceIdDesc: "系统 voice_id 或你自己的克隆 voice_id。",
    minimaxLanguageBoostDesc: "中文可用 Chinese，自动识别用 auto。",
    speedDesc: "语速。",
    volumeDesc: "音量。",
    pitchDesc: "音高。",
    replicateApiTokenDesc: "Replicate API token。",
    replicateModelDesc: "默认使用 Replicate 官方 MiniMax Speech 2.8 Turbo；其他模型可填 owner/name。",
    replicateVoiceDesc: "选择 Custom 时，会使用下一项填写的自定义 voice_id。",
    replicateCustomVoiceIdDesc: "当 Voice 选择 Custom 时使用，用于 MiniMax voice cloning 返回的 voice_id。",
    replicateLanguagePreferenceDesc: "默认 Auto，让 MiniMax 自动判断语言。",
    replicateEmotionDesc: "默认 Auto，让 MiniMax 自动选择表达情绪。",
    replicateSpeedDesc: "语速，Replicate MiniMax 支持 0.5 到 2。",
    replicateVolumeDesc: "音量，Replicate MiniMax 支持 0 到 10。",
    replicatePitchDesc: "音高，Replicate MiniMax 支持 -12 到 12。",
    advancedReplicateHeading: "高级 Replicate 模型",
    replicateVersionDesc: "非官方模型需要填写 version hash。",
    replicateInputTemplateDesc: "使用 {{text}} 插入笔记文本。",
    customEndpointDesc: "返回二进制音频或 JSON 都可以。",
    customMethodDesc: "通常是 POST。",
    customHeadersDesc: "使用 {{text}} 插入文本；一般不需要。",
    customBodyTemplateDesc: "使用 {{text}} 插入笔记文本。",
    customChunkCharactersDesc: "大于 0 时，插件会把长文本拆成多次 Custom HTTP 请求再合并 WAV；手机端建议 40-80。",
    customAudioUrlPathDesc: "例如 data.audio_url。",
    customAudioHexPathDesc: "例如 data.audio。",
    customAudioBase64PathDesc: "例如 data.audio_base64。",
    gptsovitsEndpointName: "服务接口 (Endpoint)",
    gptsovitsEndpointDesc: "本地或私有部署的 GPT-SoVITS /tts 接口，默认本地 9880 端口。",
    gptsovitsVoicePresetName: "音色预设 (Voice Preset)",
    gptsovitsVoicePresetDesc: "选择刘飞、孟岩或自定义音色。内置音色各使用一套固定的模型与参考音频。",
    gptsovitsCustomRefAudioName: "自定义参考音频路径",
    gptsovitsCustomRefAudioDesc: "服务端文件路径（如 reference_audio/xxx.wav 或绝对路径）。",
    gptsovitsCustomPromptTextName: "参考音频文本",
    gptsovitsCustomPromptTextDesc: "该参考音频对应的准确文字内容。",
    gptsovitsSpeedName: "语速倍率 (Speed)",
    gptsovitsSpeedDesc: "调节说话语速，默认 1.0。小于 1 放慢，大于 1 加快。",
    gptsovitsTemperatureName: "采样温度",
    gptsovitsTemperatureDesc: "控制采样随机度，默认 0.82。实际使用此处设置的值；更高或更低都不保证更像原声。",
    testGptSoVitsButton: "测试本地语音连接",
    testGptSoVitsDesc: "发送一句测试文本至本地 GPT-SoVITS 验证连通性并试听。",
  },
  en: {
    settingsLanguageName: "Settings language",
    settingsLanguageDesc: "Choose settings language. Auto detects Obsidian's UI language.",
    settingsLanguageAuto: "Auto (Follow Obsidian)",
    settingsLanguageZh: "Chinese",
    settingsLanguageEn: "English",
    providerDesc: "Choose which API provider generates speech.",
    outputFolderName: "Output folder",
    outputFolderDesc: "Generated MP3 files are saved to this folder inside your vault.",
    maxCharactersName: "Maximum characters",
    maxCharactersDesc: "Prevents accidentally sending very long notes to a synchronous API.",
    chunkCharactersName: "Chunk characters",
    chunkCharactersDesc: "Use 0 to disable chunking. Local GPT-SoVITS keeps paragraphs separate, targeting 80 characters initially and 160 thereafter at punctuation boundaries. Larger values do not repack paragraphs. Other providers use this character limit.",
    stripMarkdownName: "Clean Markdown before conversion",
    stripMarkdownDesc: "Removes code blocks, link syntax, and common Markdown markers.",
    textCleanupHeading: "Text cleanup",
    removeFrontmatterName: "Remove YAML/frontmatter",
    removeFrontmatterDesc: "Skips metadata at the top of notes, such as date, type, and tags.",
    removeTagsName: "Remove tags",
    removeTagsDesc: "Skips #tag entries and tags: fields.",
    removeLinksName: "Remove link URLs",
    removeLinksDesc: "Keeps link text but does not read URLs aloud.",
    removeUrlsName: "Remove bare URLs",
    removeUrlsDesc: "Skips https:// links written directly in the note body.",
    removeEmbedsName: "Remove images and embeds",
    removeEmbedsDesc: "Skips Markdown images and Obsidian embeds.",
    removeHtmlCommentsName: "Remove HTML comments",
    removeHtmlCommentsDesc: "Skips <!-- comment --> content.",
    skipLinePatternsName: "Skip whole-line rules",
    skipLinePatternsDesc: "One regular expression per line. Matching lines are not sent to the speech API.",
    voiceOptimizationHeading: "Voice and reading optimization",
    includeTitleInAudioName: "Include note title in audio",
    includeTitleInAudioDesc: "Automatically prepends the note title when synthesizing the entire note. Avoids duplication if already present at the start of the body.",
    optimizeAcronymsName: "Optimize English acronyms",
    optimizeAcronymsDesc: "Automatically inserts spaces between consecutive uppercase letters, such as SDK and API, so they are not read as a single word or run together.",
    optimizeHyphensName: "Optimize hyphens and dashes",
    optimizeHyphensDesc: "Silences hyphens between Chinese characters (e.g. root-trunk-branch-leaf) to avoid reading as 'minus', and normalizes dashes for natural pauses.",
    addPauseAtLineBreaksName: "Add pauses at line ends",
    addPauseAtLineBreaksDesc: "If a line ends without punctuation, such as headings or list items, add a pause mark so it does not run into the next line.",
    lineBreakPauseTypeName: "Line-end pause mark",
    lineBreakPauseTypeDesc: "Choose whether lines without punctuation end with a period for a longer pause or a comma for a shorter pause.",
    lineBreakPausePeriod: "Period .",
    lineBreakPauseComma: "Comma ,",
    addSpaceAfterPunctuationName: "Add spaces after punctuation",
    addSpaceAfterPunctuationDesc: "Adds a space after punctuation marks, such as commas, periods, semicolons, question marks, exclamation marks, colons, and Chinese enumeration commas, to help TTS produce more natural short pauses.",
    volcengineAppIdDesc: "App ID obtained from Volcengine Speech Console.",
    volcengineAccessTokenDesc: "Access Token or API Key created in Volcengine Console.",
    volcengineClusterDesc: "Defaults to volcano_tts.",
    volcengineVoiceDesc: "Preset natural voices used in Mowen/Doubao, or enter a custom voice code.",
    volcengineCustomVoiceDesc: "Custom Voice Type code, e.g. BV001_streaming.",
    volcengineSpeedDesc: "Speech speed ratio, default 1.0 (usual range 0.5–2.0).",
    volcengineVolumeDesc: "Volume ratio, default 1.0 (range 0.1 ~ 3.0).",
    volcenginePitchDesc: "Pitch ratio, default 1.0 (range 0.1 ~ 3.0).",
    storageHeading: "Storage & Cache Management (Anti-bloat)",
    storageStatsDesc: "Statistics of local audio files stored in your vault and storage usage.",
    keepOnlyLatestAudioName: "Single-note Overwrite Mode",
    keepOnlyLatestAudioDesc: "Overwrites previous audio when regenerating for the same note, avoiding accumulating duplicate files and saving iCloud sync bandwidth.",
    cleanOrphansBtn: "Clean Orphan Audios",
    clearAllAudiosBtn: "Clear All Generated Audios",
    clearAllConfirm: "Are you sure you want to delete all audio files in the TTS Audio folder? Note contents will not be affected.",
    noteAssociationHeading: "Note & Audio Bidirectional Association",
    associateNoteFrontmatterName: "Write link to Note Frontmatter",
    associateNoteFrontmatterDesc: "Automatically records the audio link (e.g. audio: [[TTS Audio/xxx.mp3]]) in the YAML frontmatter of the note.",
    frontmatterKeyName: "Frontmatter Property Key",
    frontmatterKeyDesc: "YAML property key for the audio link, defaults to audio.",
    autoEmbedInNoteName: "Auto embed player in Note content",
    autoEmbedInNoteDesc: "Inserts ![[...]] syntax to display an audio player directly inside the note.",
    autoEmbedNone: "Do not embed",
    autoEmbedTop: "Embed at the top of note",
    autoEmbedBottom: "Embed at the bottom of note",
    autoOpenPlayerAfterGenerateName: "Auto open player after generation",
    autoOpenPlayerAfterGenerateDesc: "Open the player after the full audio is saved. Manual local multi-chunk generation provides an early player independently and does not open another player on completion.",
    showTitleInlineButtonName: "Show Mowen-style 'Listen All' pill button",
    showTitleInlineButtonDesc: "Display a minimal Mowen-style pill button beside note title. Generates in background, shows checkmark when ready, plays without regenerating if unmodified.",
    titleButtonPositionName: "Pill Button Position",
    titleButtonPositionDesc: "Select where the 'Listen All' pill button is mounted in your note.",
    posRight: "Right of title (Recommended)",
    posTop: "Above title (Mowen default)",
    posBottom: "Below title (Between title and body)",
    showPodcastCardName: "Show audio player bar at note top",
    showPodcastCardDesc: "Embed a compact, elegant audio player bar below note title to listen directly inside the note.",
    podcastCardTitleName: "Podcast card title",
    podcastCardTitleDesc: "Title text displayed at the top of the podcast card, defaults to '收听播客'.",
    enableFloatingPlayerName: "Enable Floating Companion Player (Follow scroll)",
    enableFloatingPlayerDesc: "Dock a modern frosted-glass player at the bottom of the note. Stays accessible while scrolling, supports pause/resume, seek, speed, and minimize.",
    enableSentenceHighlightName: "Sentence-by-sentence Highlighting",
    enableSentenceHighlightDesc: "Uses local speech timestamps when available; shows estimated status when alignment is unavailable.",
    enableAutoScrollName: "Auto-scroll Viewport with Voice",
    enableAutoScrollDesc: "Automatically scrolls the viewport smoothly to center the currently playing sentence.",
    highlightLeadTimeName: "Highlight sync",
    highlightLeadTimeDesc: "Only affects estimated highlighting; ignored after speech alignment succeeds. Delay if early, advance if late. Default: no offset. Uses real seconds at the current rate and applies to all notes.",
    testVolcengineButton: "Test Volcengine Voice",
    testVolcengineDesc: "Sends a sample text to verify that AppID, Token, and Voice are configured properly.",
    minimaxApiKeyDesc: "Bearer token.",
    minimaxEndpointDesc: "Uses HTTP T2A by default.",
    minimaxModelDesc: "For example, speech-2.8-turbo or speech-2.8-hd.",
    minimaxVoiceIdDesc: "A system voice_id or your own cloned voice_id.",
    minimaxLanguageBoostDesc: "Use Chinese for Chinese text, or auto for automatic detection.",
    speedDesc: "Speech speed.",
    volumeDesc: "Volume.",
    pitchDesc: "Pitch.",
    replicateApiTokenDesc: "Replicate API token.",
    replicateModelDesc: "Uses Replicate's official MiniMax Speech 2.8 Turbo model by default. Other models can use owner/name.",
    replicateVoiceDesc: "When Custom is selected, the next setting supplies the custom voice_id.",
    replicateCustomVoiceIdDesc: "Used when Voice is set to Custom. This is the voice_id returned by MiniMax voice cloning.",
    replicateLanguagePreferenceDesc: "Auto lets MiniMax detect the language automatically.",
    replicateEmotionDesc: "Auto lets MiniMax choose the expressive emotion automatically.",
    replicateSpeedDesc: "Speech speed. Replicate MiniMax supports 0.5 to 2.",
    replicateVolumeDesc: "Volume. Replicate MiniMax supports 0 to 10.",
    replicatePitchDesc: "Pitch. Replicate MiniMax supports -12 to 12.",
    advancedReplicateHeading: "Advanced Replicate model",
    replicateVersionDesc: "Unofficial models need a version hash.",
    replicateInputTemplateDesc: "Use {{text}} to insert the note text.",
    customEndpointDesc: "Can return either binary audio or JSON.",
    customMethodDesc: "Usually POST.",
    customHeadersDesc: "Use {{text}} to insert text. Usually not needed.",
    customBodyTemplateDesc: "Use {{text}} to insert the note text.",
    customChunkCharactersDesc: "When greater than 0, the plugin splits long text into multiple Custom HTTP requests and merges WAV files. Recommended on mobile: 40-80.",
    customAudioUrlPathDesc: "For example, data.audio_url.",
    customAudioHexPathDesc: "For example, data.audio.",
    customAudioBase64PathDesc: "For example, data.audio_base64.",
    gptsovitsEndpointName: "Service Endpoint",
    gptsovitsEndpointDesc: "Local or private GPT-SoVITS /tts endpoint, defaults to port 9880.",
    gptsovitsVoicePresetName: "Voice Preset",
    gptsovitsVoicePresetDesc: "Select voice preset (supports Liu Fei and Meng Yan podcast voices).",
    gptsovitsCustomRefAudioName: "Custom Reference Audio Path",
    gptsovitsCustomRefAudioDesc: "Server-side audio path (e.g. reference_audio/xxx.wav or absolute path).",
    gptsovitsCustomPromptTextName: "Prompt Text",
    gptsovitsCustomPromptTextDesc: "Accurate text corresponding to the reference audio.",
    gptsovitsSpeedName: "Speed Factor",
    gptsovitsSpeedDesc: "Adjust speech speed, default 1.0.",
    gptsovitsTemperatureName: "Sampling Temperature",
    gptsovitsTemperatureDesc: "Controls sampling randomness, default 0.82. This setting is used directly; higher or lower does not guarantee better similarity.",
    testGptSoVitsButton: "Test Local Voice & Connection",
    testGptSoVitsDesc: "Send a test request to GPT-SoVITS to verify connection and preview audio.",
  },
};

function getSettingsDisplayLanguage(selected: SettingsLanguage): "zh" | "en" {
  if (selected === "zh" || selected === "en") {
    return selected;
  }
  const locale = (window.localStorage.getItem("language") || navigator.language || "").toLowerCase();
  return locale.startsWith("zh") ? "zh" : "en";
}

function createUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function quickHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}

function formatGenerationDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${(Math.max(0, ms) / 1000).toFixed(1)} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分 ${seconds % 60} 秒`;
}

export default class NoteTtsPlugin extends Plugin {
  settings: NoteTtsSettings;
  pendingTasks: PendingTtsTask[] = [];
  activeSynthesizingPaths: Set<string> = new Set();
  noteContentHashes: Record<string, string> = {};
  ribbonIconEl: HTMLElement | null = null;
  statusBarEl: HTMLElement | null = null;
  isBatchSyncing: boolean = false;
  activeFloatingPlayer: NoteFloatingPlayer | null = null;
  savedAudioPositions: Map<string, number> = new Map();
  private refreshDebounceTimer: number | null = null;
  private earlyPlayer: ProgressiveAudioPlayer | null = null;
  private unloading = false;
  private activeAudioRequests = 0;
  private savingVoiceSelection = false;
  private generationTasks = new Set<GenerationTask>();
  private manualTasks = new Map<string, Promise<unknown>>();
  private localAudioQueue: Promise<void> = Promise.resolve();
  private audioSaveQueue: Promise<void> = Promise.resolve();
  private generationWaiters = new Set<() => void>();
  private pausedBatchTask: GenerationTask | null = null;
  batchPaused = false;
  batchPauseState: { resumeAt: number | null; folderPath: string } | null = null;
  private batchFolderPath = "";
  private manualCompletedPaths = new Set<string>();
  private generationLogWriteQueue: Promise<void> = Promise.resolve();
  private activeGenerationIds = new Set<string>();
  private speechTimingJobs = new Map<string, Promise<SpeechTiming>>();
  private speechTimingQueue: Promise<void> = Promise.resolve();
  private speechTimingProcesses = new Set<import("child_process").ChildProcess>();

  refreshAllInlineButtonsDebounced(delay = 150) {
    if (this.refreshDebounceTimer !== null) {
      window.clearTimeout(this.refreshDebounceTimer);
    }
    this.refreshDebounceTimer = window.setTimeout(() => {
      this.refreshDebounceTimer = null;
      this.refreshAllInlineButtons();
    }, delay);
  }

  async onload() {
    await this.loadSettings();
    this.registerIcons();

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar("");
    this.initBatchScheduler();

    this.ribbonIconEl = this.addRibbonIcon(NOTE_TTS_NOTE_ICON, "听笔记：播放或生成当前笔记语音", async () => {
      let view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === "md") {
          for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            if (leaf.view instanceof MarkdownView && leaf.view.file?.path === activeFile.path) {
              view = leaf.view;
              break;
            }
          }
        }
      }
      if (!view || !view.file) {
        new Notice("请先打开一篇 Markdown 笔记。");
        return;
      }
      await this.handleNoteAudioAction(view);
    });

    this.addCommand({
      id: "refresh-mowen-listen-pill",
      name: "听笔记：刷新并显示「听全文」胶囊按钮",
      callback: () => {
        this.settings.showTitleInlineButton = true;
        this.refreshAllInlineButtons();
        new Notice("🎧 已强制刷新并挂载「听全文」胶囊按钮！");
      },
    });

    this.addCommand({
      id: "synthesize-current-note",
      name: "听笔记：播放或生成当前笔记语音（已有则播放）",
      icon: NOTE_TTS_NOTE_ICON,
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        await this.handleNoteAudioAction(view);
      },
    });

    this.addCommand({
      id: "force-regenerate-current-note",
      name: "听笔记：重新生成当前笔记语音（强制覆盖）",
      icon: NOTE_TTS_NOTE_ICON,
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        await this.synthesize(view, "note", editor);
      },
    });

    this.addCommand({
      id: "play-current-note-audio",
      name: "听笔记：播放当前笔记关联的语音",
      icon: NOTE_TTS_NOTE_ICON,
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        if (view.file) {
          await this.playAudioForNote(view.file);
        } else {
          new Notice("请先打开一篇笔记。");
        }
      },
    });

    this.addCommand({
      id: "synthesize-selection",
      name: "听笔记：朗读选中文字",
      icon: NOTE_TTS_SELECTION_ICON,
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        await this.synthesize(view, "selection", editor);
      },
    });

    this.addCommand({
      id: "preview-cleaned-text",
      name: "听笔记：预览清洗后的朗读文本",
      icon: NOTE_TTS_PREVIEW_ICON,
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        const mode = editor.getSelection() ? "selection" : "note";
        const sourceText = await this.getTextForMode(view, mode, editor);
        const noteTitle = mode === "note" ? this.getNoteTitle(view.file, sourceText) : undefined;
        new CleanedTextPreviewModal(this.app, this.prepareText(sourceText, noteTitle)).open();
      },
    });

    this.addCommand({
      id: "view-generation-logs",
      name: "听笔记：查看最近生成日志",
      callback: () => { new GenerationLogsModal(this.app).open(); },
    });

    this.addCommand({
      id: "check-pending-tts-tasks",
      name: "听笔记：检查后台待处理任务",
      icon: NOTE_TTS_NOTE_ICON,
      callback: async () => {
        await this.checkPendingTasks();
      },
    });

    this.addCommand({
      id: "sync-configured-batch-folder",
      name: "听笔记：增量同步已配置目录的音频",
      icon: NOTE_TTS_NOTE_ICON,
      callback: async () => {
        if (!this.settings.batchSyncFolder?.trim()) {
          new Notice("请先在插件设置中指定「监控的笔记目录」。");
          return;
        }
        await this.syncFolderAudio(this.settings.batchSyncFolder, false);
      },
    });

    this.addCommand({
      id: "sync-current-note-folder",
      name: "听笔记：增量生成当前笔记所在目录的音频",
      icon: NOTE_TTS_NOTE_ICON,
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || !activeFile.parent) return false;
        if (checking) return true;
        void this.syncFolderAudio(activeFile.parent, false).catch(error => new Notice(errorMessage(error)));
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view: MarkdownView) => {
        menu.addItem((item) => {
          item
            .setTitle("听笔记：朗读当前整篇笔记")
            .setIcon(NOTE_TTS_NOTE_ICON)
            .onClick(async () => {
              await this.synthesize(view, "note", editor);
            });
        });
        menu.addItem((item) => {
          item
            .setTitle("听笔记：朗读选中的文字")
            .setIcon(NOTE_TTS_SELECTION_ICON)
            .onClick(async () => {
              await this.synthesize(view, "selection", editor);
            });
        });
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file) => {
        if (file instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle("听笔记：增量生成此目录内所有笔记音频")
              .setIcon(NOTE_TTS_NOTE_ICON)
              .onClick(async () => {
                await this.syncFolderAudio(file, false);
              });
          });
          return;
        }

        if (!(file instanceof TFile) || file.extension !== "md") {
          return;
        }

        menu.addItem((item) => {
          item
            .setTitle("听笔记：播放该笔记关联语音")
            .setIcon(NOTE_TTS_NOTE_ICON)
            .onClick(async () => {
              await this.playAudioForNote(file);
            });
        });
        menu.addItem((item) => {
          item
            .setTitle("听笔记：生成该笔记语音并保存")
            .setIcon(NOTE_TTS_NOTE_ICON)
            .onClick(async () => {
              await this.synthesizeFile(file);
            });
        });
      })
    );

    // 监听视图切换与渲染，自动在文章标题旁挂载「听笔记 / 播放」按钮
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshAllInlineButtonsDebounced(60);
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.refreshAllInlineButtonsDebounced(60);
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.refreshAllInlineButtonsDebounced(150);
      })
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", () => {
        this.refreshAllInlineButtonsDebounced(300);
      })
    );

    this.app.workspace.onLayoutReady(() => {
      this.refreshAllInlineButtons();
      // 延迟 5 秒检查启动与唤醒补跑，避开开机/打开时高密集索引
      window.setTimeout(() => {
        this.checkStartupCatchUp();
      }, 5000);
    });

    this.addSettingTab(new NoteTtsSettingTab(this.app, this));
  }

  onunload() {
    this.unloading = true;
    this.wakeGenerationWaiters();
    for (const child of this.speechTimingProcesses) child.kill();
    this.speechTimingProcesses.clear();
    this.earlyPlayer?.destroy();
    this.activeFloatingPlayer?.destroy();
    this.activeFloatingPlayer = null;
    document.querySelectorAll(".podvoice-floating-bar").forEach((el) => el.remove());
    document.querySelectorAll(".podvoice-active-line").forEach((el) => el.removeClass("podvoice-active-line"));
    document.querySelectorAll(".podvoice-sentence-active").forEach((el) => el.removeClass("podvoice-sentence-active"));
    document.querySelectorAll(".podvoice-podcast-card").forEach((el) => el.remove());
    document.querySelectorAll(".podvoice-inline-btn, .podvoice-mowen-pill").forEach((el) => el.remove());
    document.querySelectorAll(".podvoice-header-btn").forEach((el) => el.remove());
  }

  async loadSettings() {
    const data = await this.loadData() as StoredPluginData | null;
    // Retire per-speaker experimental version preferences while preserving other settings.
    const { gptsovitsPreferredPresets: _retiredPreferences, ...savedSettings } = data || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
    this.settings.gptsovitsVoicePreset = normalizeGptSoVitsVoicePreset(this.settings.gptsovitsVoicePreset);
    if (this.settings.showTitleInlineButton === undefined) {
      this.settings.showTitleInlineButton = true;
    }
    if (this.settings.optimizeHyphens === undefined) {
      this.settings.optimizeHyphens = true;
    }
    this.batchPauseState = data?.batchPauseState && (data.batchPauseState.resumeAt === null || Number.isFinite(data.batchPauseState.resumeAt))
      ? data.batchPauseState : null;
    this.batchPaused = Boolean(this.batchPauseState);
    this.pendingTasks = Array.isArray(data?.pendingTasks) ? data.pendingTasks : [];
    this.noteContentHashes = (typeof data?.noteContentHashes === "object" && data.noteContentHashes) || {};
  }

  async saveSettings() {
    await this.saveData({
      ...this.settings,
      pendingTasks: this.pendingTasks,
      noteContentHashes: this.noteContentHashes,
      batchPauseState: this.batchPauseState,
    });
  }

  async isNoteModifiedSinceAudio(file: TFile, audioFile: TFile, currentText?: string): Promise<boolean> {
    try {
      const text = currentText ?? (await this.app.vault.read(file));
      // 去除 frontmatter 得到纯文本计算哈希
      const cleanBody = text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
      const currentHash = quickHash(cleanBody);
      const recordedHash = this.noteContentHashes[file.path];

      if (recordedHash) {
        return currentHash !== recordedHash;
      }

      // 若无 hash 记录（如升级前生成的音频），宽容比对修改时间（音频保存 5 秒内写入 frontmatter 视为同期生成，不误判修改）
      if (file.stat.mtime > audioFile.stat.mtime + 5000) {
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  updateStatusBar(text: string) {
    if (this.batchPaused) {
      const at = this.batchPauseState?.resumeAt;
      text = at ? `🎧 批量已暂停，${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} 后等待手动任务结束再恢复`
        : this.batchPauseState ? "🎧 批量已暂停，可切换音色或手动生成" : "🎧 批量等待手动任务结束后恢复";
    }
    if (this.statusBarEl) {
      this.statusBarEl.setText(text);
      if (text) {
        this.statusBarEl.setAttribute("aria-label", text);
      } else {
        this.statusBarEl.removeAttribute("aria-label");
      }
    }
  }

  initBatchScheduler() {
    this.registerInterval(
      window.setInterval(() => {
        this.checkScheduledBatchSync();
      }, 60000)
    );
  }

  private checkScheduledBatchSync() {
    if (this.batchPauseState) {
      if (this.batchPauseState.resumeAt !== null && Date.now() >= this.batchPauseState.resumeAt) {
        void this.resumeBatchGeneration().catch(error => console.error(error));
      }
      return;
    }
    if (!this.settings.batchScheduleEnabled || !this.settings.batchSyncFolder?.trim()) {
      return;
    }
    const now = new Date();
    const currentHourMin = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    if (this.settings.lastBatchSyncDate === todayStr) {
      return;
    }

    const targetTime = (this.settings.batchScheduleTime || "00:00").trim();
    if (currentHourMin === targetTime) {
      void this.syncFolderAudio(this.settings.batchSyncFolder, true).catch(error => new Notice(errorMessage(error)));
    }
  }

  private checkStartupCatchUp() {
    if (this.batchPauseState) { this.checkScheduledBatchSync(); this.updateStatusBar(""); return; }
    if (
      !this.settings.batchScheduleEnabled ||
      !this.settings.batchCatchUpOnStartup ||
      !this.settings.batchSyncFolder?.trim()
    ) {
      return;
    }

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    if (this.settings.lastBatchSyncDate === todayStr) {
      return;
    }

    const [schedHour, schedMin] = (this.settings.batchScheduleTime || "00:00").split(":").map(Number);
    const targetDate = new Date();
    targetDate.setHours(schedHour || 0, schedMin || 0, 0, 0);

    // 如果当前时间已经过了今天的设定时间点，说明休眠或关机错过了今日的定时
    if (now.getTime() >= targetDate.getTime()) {
      void this.syncFolderAudio(this.settings.batchSyncFolder, true).catch(error => new Notice(errorMessage(error)));
    }
  }

  checkNoteAudioStatus(noteFile: TFile): { needsGeneration: boolean; audioFile: TFile | null; reason: string } {
    const audioFile = this.findExistingAudioForNote(noteFile);
    if (!audioFile) {
      return { needsGeneration: true, audioFile: null, reason: "尚未生成本地音频" };
    }
    if (!this.settings.batchSkipUnmodified) {
      return { needsGeneration: true, audioFile, reason: "已关闭增量跳过，强制重新生成" };
    }
    if (noteFile.stat.mtime > audioFile.stat.mtime) {
      return { needsGeneration: true, audioFile, reason: "笔记有修改（修改时间晚于音频生成时间）" };
    }
    return { needsGeneration: false, audioFile, reason: "音频已是最新" };
  }

  private wakeGenerationWaiters() {
    const waiters = [...this.generationWaiters];
    this.generationWaiters.clear();
    waiters.forEach(resolve => resolve());
  }

  private async acquireGenerationTask(task: GenerationTask) {
    while (!this.unloading && (this.savingVoiceSelection
      || [...this.generationTasks].some(active => task.path && active.path === task.path)
      || (task.kind === "batch" && (this.batchPauseState
        || this.manualTasks.size > 0)))) {
      await new Promise<void>(resolve => this.generationWaiters.add(resolve));
    }
    if (this.unloading) throw new Error("插件已卸载，停止生成。");
    task.settings ??= { ...this.settings };
    this.generationTasks.add(task);
    if (task.path) this.activeSynthesizingPaths.add(task.path);
    if (task.kind === "batch") this.batchPaused = false;
  }

  private runGenerationTask<T>(kind: GenerationTask["kind"], path: string | undefined, run: (task: GenerationTask) => Promise<T>): Promise<T> {
    // Coalesce rapid clicks before any asynchronous reads or configuration saves.
    const key = path || "__voice_preview__";
    if (kind === "manual" && this.manualTasks.has(key)) return this.manualTasks.get(key) as Promise<T>;
    const task: GenerationTask = { kind, path,
      settings: kind === "manual" && !this.savingVoiceSelection ? { ...this.settings } : undefined };
    const result = (async () => {
      try {
        await this.acquireGenerationTask(task);
        return await run(task);
      } finally {
        if (this.generationTasks.delete(task) && task.path) this.activeSynthesizingPaths.delete(task.path);
        if (kind === "manual") this.manualTasks.delete(key);
        this.refreshAllInlineButtons();
        if (kind === "batch" && this.batchPauseState) this.batchPaused = true;
        this.wakeGenerationWaiters();
      }
    })();
    if (kind === "manual") this.manualTasks.set(key, result);
    return result;
  }

  async pauseBatchGeneration(resumeAt: number | null = null) {
    if (resumeAt !== null && !Number.isFinite(resumeAt)) throw new Error("恢复时间无效。");
    this.batchPauseState = { resumeAt, folderPath: this.batchFolderPath || this.settings.batchSyncFolder };
    this.batchPaused = ![...this.generationTasks].some(task => task.kind === "batch");
    await this.saveSettings();
    this.updateStatusBar("批量任务将在当前小段完成后暂停");
  }

  async resumeBatchGeneration() {
    if (!this.batchPauseState) return;
    const paused = this.batchPauseState;
    while (this.savingVoiceSelection && !this.unloading) {
      await new Promise<void>(resolve => this.generationWaiters.add(resolve));
    }
    if (this.unloading || this.batchPauseState !== paused) return;
    // Keep the pause effective until persistence succeeds, including across a restart.
    await this.saveData({ ...this.settings, pendingTasks: this.pendingTasks,
      noteContentHashes: this.noteContentHashes, batchPauseState: null });
    if (this.batchPauseState !== paused) return;
    this.batchPauseState = null;
    this.updateStatusBar("批量任务等待当前手动任务结束后恢复");
    this.wakeGenerationWaiters();
    if (!this.isBatchSyncing && !this.pausedBatchTask && paused.folderPath) {
      void this.syncFolderAudio(paused.folderPath, true).catch(error => console.error(error));
    }
  }

  // Called only between completed local requests; never releases a model in mid-request.
  private async batchCheckpoint(task: GenerationTask | null | undefined, requestActive = true) {
    if (!task || task.kind !== "batch") return;
    if (this.batchPauseState) {
      this.pausedBatchTask = task;
      this.batchPaused = true;
      this.generationTasks.delete(task);
      if (task.path) this.activeSynthesizingPaths.delete(task.path);
      if (task.logId) this.activeGenerationIds.delete(task.logId);
      if (requestActive) this.activeAudioRequests--;
      this.updateStatusBar("");
      this.refreshAllInlineButtons();
      this.wakeGenerationWaiters();
      try { await this.acquireGenerationTask(task); }
      finally {
        if (requestActive) this.activeAudioRequests++;
        if (task.path) this.activeSynthesizingPaths.add(task.path);
        if (task.logId) this.activeGenerationIds.add(task.logId);
        this.pausedBatchTask = null;
      }
    }
    if (this.unloading) throw new Error("插件已卸载，停止生成。");
    if (task.path && this.manualCompletedPaths.has(task.path)) throw new BatchSupersededError();
  }

  async synthesizeFileQuiet(file: TFile, onStatus?: (status: string) => void): Promise<TFile> {
    return this.runGenerationTask("batch", file.path, async (task) => {
      if (this.manualCompletedPaths.has(file.path)) throw new BatchSupersededError();
      return this.synthesizeFileQuietNow(file, onStatus, task);
    });
  }

  private async synthesizeFileQuietNow(file: TFile, onStatus: ((status: string) => void) | undefined, task: GenerationTask): Promise<TFile> {
    const settings = task.settings!;
    this.activeSynthesizingPaths.add(file.path);
    this.refreshAllInlineButtons();
    try {
      onStatus?.("读取笔记");
      const rawContent = await this.app.vault.read(file);
      const noteTitle = this.getNoteTitle(file, rawContent);
      const text = this.prepareText(rawContent, noteTitle, settings);
      if (!text.trim()) {
        throw new Error("笔记内容为空，无法生成语音");
      }
      if (text.length > settings.maxCharacters) {
        throw new Error(`笔记长度 (${text.length}) 超过设置的最大字符限制 (${settings.maxCharacters})`);
      }

      onStatus?.("请求合成");
      const { value: saved, durationMs } = await this.generateAndSaveAudio(text, file, "batch", undefined, () => onStatus?.("保存文件"), task);
      onStatus?.(`已完成，用时 ${formatGenerationDuration(durationMs)}`);
      return saved;
    } finally {
      this.activeSynthesizingPaths.delete(file.path);
      this.refreshAllInlineButtons();
    }
  }

  async syncFolderAudio(folderInput: TFolder | string, silent: boolean = false): Promise<void> {
    if (this.isBatchSyncing) {
      if (!silent) new Notice("🎧 当前已有音频批量生成任务在运行中，请稍候...");
      return;
    }

    let folder: TFolder | null = null;
    if (typeof folderInput === "string") {
      const cleanPath = normalizeFolder(folderInput);
      const abstract = cleanPath === "" && /^\/+$/u.test(folderInput)
        ? this.app.vault.getRoot()
        : this.app.vault.getAbstractFileByPath(cleanPath);
      if (abstract instanceof TFolder) {
        folder = abstract;
      }
    } else if (folderInput instanceof TFolder) {
      folder = folderInput;
    }

    if (!folder) {
      const folderName = typeof folderInput === "string" ? folderInput : folderInput?.name;
      if (!silent) new Notice(`未在仓库中找到目标目录：「${folderName}」`);
      return;
    }

    // 收集目录下所有 Markdown 笔记
    const markdownFiles: TFile[] = [];
    const collectMarkdown = (current: TFolder) => {
      for (const child of current.children) {
        if (child instanceof TFile && child.extension === "md") {
          markdownFiles.push(child);
        } else if (child instanceof TFolder && this.settings.batchIncludeSubfolders) {
          collectMarkdown(child);
        }
      }
    };
    collectMarkdown(folder);

    if (markdownFiles.length === 0) {
      if (!silent) new Notice(`目录「${folder.name}」内没有发现 Markdown 笔记。`);
      return;
    }

    // 增量筛选判断
    const toGenerate: { file: TFile; reason: string }[] = [];
    let upToDateCount = 0;
    for (const f of markdownFiles) {
      const check = this.checkNoteAudioStatus(f);
      if (check.needsGeneration) {
        toGenerate.push({ file: f, reason: check.reason });
      } else {
        upToDateCount++;
      }
    }

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    if (toGenerate.length === 0) {
      this.settings.lastBatchSyncDate = todayStr;
      await this.saveSettings();
      if (!silent) {
        new Notice(`🎧 目录「${folder.name}」全部 ${markdownFiles.length} 篇笔记音频均已是最新，无需重新生成。`);
      }
      return;
    }

    this.isBatchSyncing = true;
    this.batchFolderPath = folder.path;
    this.manualCompletedPaths.clear();
    const batchStarted = performance.now();
    let pendingCount = 0;
    if (!silent) {
      new Notice(`🎧 开始批量增量生成「${folder.name}」音频：待处理 ${toGenerate.length} 篇，跳过最新 ${upToDateCount} 篇...`, 5000);
    }
    this.updateStatusBar(`🎧 听笔记: 准备中 (0/${toGenerate.length})...`);

    let successCount = 0;
    let supersededCount = 0;
    const failedList: { title: string; err: string }[] = [];

    try {
      for (let i = 0; i < toGenerate.length; i++) {
        const item = toGenerate[i];
        const currentIdx = i + 1;
        const total = toGenerate.length;

        this.updateStatusBar(`🎧 听笔记 (${currentIdx}/${total}): ${item.file.basename.slice(0, 12)}...`);

        try {
          await this.synthesizeFileQuiet(item.file, (status) => {
            this.updateStatusBar(`🎧 听笔记 (${currentIdx}/${total}) [${status}]: ${item.file.basename.slice(0, 10)}`);
          });
          successCount++;
        } catch (err: unknown) {
          if (this.unloading) return;
          if (err instanceof BatchSupersededError) {
            supersededCount++;
          } else if (err instanceof PendingTaskError) {
            pendingCount++;
          } else {
            console.error(`批量生成「${item.file.basename}」失败:`, err);
            failedList.push({ title: item.file.basename, err: errorMessage(err) });
          }
        }

        // 间歇防高频限流
        if (i < toGenerate.length - 1) {
          await sleep(600);
        }
      }

      this.settings.lastBatchSyncDate = todayStr;
      await this.saveSettings();

      this.updateStatusBar(`🎧 听笔记: 同步完成 (${successCount}/${toGenerate.length})`);
      window.setTimeout(() => this.updateStatusBar(""), 6000);

      let summary = `🎧 目录「${folder.name}」音频同步完成！\n• 成功更新: ${successCount} 篇\n• 保持最新跳过: ${upToDateCount} 篇`;
      if (failedList.length > 0) {
        summary += `\n• 失败: ${failedList.length} 篇 (${failedList.map((f) => f.title).join(", ")})`;
      }
      if (supersededCount) summary += `\n• 已手动生成，跳过旧任务: ${supersededCount} 篇`;
      if (pendingCount) summary += `\n• 待完成或待同步: ${pendingCount} 篇`;
      summary += `\n• 本次用时: ${formatGenerationDuration(performance.now() - batchStarted)}`;
      new Notice(summary, 8000);
    } finally {
      this.isBatchSyncing = false;
    }
  }

  private registerIcons() {
    addIcon(NOTE_TTS_SELECTION_ICON, NOTE_TTS_SELECTION_ICON_SVG);
    addIcon(NOTE_TTS_PREVIEW_ICON, NOTE_TTS_PREVIEW_ICON_SVG);
  }

  private async synthesizeActiveView(mode: "note" | "selection") {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("请先打开一篇 Markdown 笔记。");
      return;
    }
    await this.synthesize(view, mode, view.editor);
  }

  async synthesizeFile(file: TFile) {
    return this.runGenerationTask("manual", file.path, task => this.synthesizeFileNow(file, task));
  }

  private async synthesizeFileNow(file: TFile, task: GenerationTask) {
    const settings = task.settings!;
    this.activeSynthesizingPaths.add(file.path);
    this.refreshAllInlineButtons();
    const status = new TtsStatusModal(this.app);
    status.open();
    status.setStatus("正在读取笔记...");

    const rawContent = await this.app.vault.read(file);
    const noteTitle = this.getNoteTitle(file, rawContent);
    const text = this.prepareText(rawContent, noteTitle, settings);
    if (!text.trim()) {
      this.activeSynthesizingPaths.delete(file.path);
      this.refreshAllInlineButtons();
      status.close();
      new Notice("没有可转换的笔记内容。");
      return;
    }

    if (text.length > settings.maxCharacters) {
      this.activeSynthesizingPaths.delete(file.path);
      this.refreshAllInlineButtons();
      status.close();
      new Notice(`文本超过 ${settings.maxCharacters} 字符，请先选中较短片段。`);
      return;
    }

    try {
      status.setStatus("正在请求语音模型...");
      const { value: saved, durationMs, earlyPlayback } = await this.generateAndSaveAudio(text, file, "note", status, undefined, task);
      status.setStatus("语音已生成。");
      status.close();
      new Notice(`语音已生成，本次用时 ${formatGenerationDuration(durationMs)}。`);
      if (settings.autoOpenPlayerAfterGenerate && !earlyPlayback) {
        new AudioResultModal(this.app, saved, file, this).open();
      }
    } catch (error) {
      if (error instanceof PendingTaskError) {
        status.close();
        new Notice(error.message, 10000);
        return;
      }
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      status.setError(message);
      new Notice(`生成失败：${message}`);
    } finally {
      this.activeSynthesizingPaths.delete(file.path);
      this.refreshAllInlineButtons();
    }
  }

  private async synthesize(view: MarkdownView, mode: "note" | "selection", editor?: Editor, silent: boolean = false) {
    const file = view.file;
    const sourceText = mode === "selection" ? editor?.getSelection() || "" : editor?.getValue();
    return this.runGenerationTask("manual", file?.path, task => this.synthesizeNow(file, mode, sourceText, silent, task));
  }

  private async synthesizeNow(activeFile: TFile | null, mode: "note" | "selection", capturedText: string | undefined, silent: boolean, task: GenerationTask) {
    const settings = task.settings!;
    if (activeFile && mode === "note") {
      this.activeSynthesizingPaths.add(activeFile.path);
      this.refreshAllInlineButtons();
    }

    let status: TtsStatusModal | undefined;
    if (!silent) {
      status = new TtsStatusModal(this.app);
      status.open();
      status.setStatus(mode === "selection" ? "正在读取选中文本..." : "正在读取当前笔记...");
    } else if (activeFile) {
      new Notice(`🎧 开始后台生成「${activeFile.basename}」全文语音...`);
    }

    const sourceText = capturedText ?? (activeFile ? await this.app.vault.read(activeFile) : "");
    const noteTitle = mode === "note" ? this.getNoteTitle(activeFile, sourceText) : undefined;
    const text = this.prepareText(sourceText, noteTitle, settings);
    if (!text.trim()) {
      if (activeFile && mode === "note") {
        this.activeSynthesizingPaths.delete(activeFile.path);
        this.refreshAllInlineButtons();
      }
      status?.close();
      new Notice(mode === "selection" ? "请先选择要转换的文本。" : "没有可转换的笔记内容。");
      return;
    }

    if (text.length > settings.maxCharacters) {
      if (activeFile && mode === "note") {
        this.activeSynthesizingPaths.delete(activeFile.path);
        this.refreshAllInlineButtons();
      }
      status?.close();
      new Notice(`文本超过 ${settings.maxCharacters} 字符，请先选中较短片段。`);
      return;
    }

    if (!activeFile) {
      status?.close();
      new Notice("没有找到当前笔记文件。");
      return;
    }

    try {
      status?.setStatus("正在请求语音模型...");
      const { value: saved, durationMs, earlyPlayback } = await this.generateAndSaveAudio(text, activeFile, mode, status, undefined, task);

      // 记录生成音频时正文哈希（去除 frontmatter）
      const cleanBody = sourceText.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
      this.noteContentHashes[activeFile.path] = quickHash(cleanBody);
      await this.saveSettings();

      status?.setStatus("语音已生成。");
      status?.close();
      new Notice(`✅ 笔记「${activeFile.basename}」${mode === "selection" ? "选区" : "全文"}语音已生成，本次用时 ${formatGenerationDuration(durationMs)}。`);
      if (settings.autoOpenPlayerAfterGenerate && !earlyPlayback) {
        new AudioResultModal(this.app, saved, activeFile, this).open();
      }
    } catch (error) {
      if (error instanceof PendingTaskError) {
        status?.close();
        new Notice(error.message, 10000);
        return;
      }
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      status?.setError(message);
      new Notice(`生成失败：${message}`);
    } finally {
      if (activeFile && mode === "note") {
        this.activeSynthesizingPaths.delete(activeFile.path);
        this.refreshAllInlineButtons();
      }
    }
  }

  private async getTextForMode(view: MarkdownView, mode: "note" | "selection", editor?: Editor) {
    if (mode === "selection") {
      return editor?.getSelection() || "";
    }

    if (editor) {
      return editor.getValue();
    }

    if (view.file) {
      return this.app.vault.read(view.file);
    }

    return "";
  }

  private getNoteTitle(file?: TFile | null, rawText?: string): string {
    if (file) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fmTitle: unknown = cache?.frontmatter?.title;
      if (typeof fmTitle === "string" && fmTitle.trim()) {
        return fmTitle.trim();
      }
      if (file.basename && file.basename.trim()) {
        return file.basename.trim();
      }
    }
    if (rawText) {
      const match = rawText.match(/^---\n([\s\S]*?)\n---/);
      if (match) {
        const titleMatch = match[1].match(/^title:\s*["']?(.*?)["']?\s*$/m);
        if (titleMatch && titleMatch[1]?.trim()) {
          return titleMatch[1].trim();
        }
      }
    }
    return "";
  }

  prepareSentenceForAlignment(text: string): string {
    return this.prepareText(text);
  }

  private prepareText(text: string, noteTitle?: string, settings = this.settings) {
    let normalized = text.replace(/\r\n/g, "\n").trim();
    if (settings.removeFrontmatter) {
      normalized = normalized.replace(/^---\n[\s\S]*?\n---\n?/, "");
    }
    if (settings.removeHtmlComments) {
      normalized = normalized.replace(/<!--[\s\S]*?-->/g, "");
    }
    if (settings.removeEmbeds) {
      normalized = normalized
        .replace(/!\[[^\]]*]\([^)]*\)/g, "")
        .replace(/!\[\[[^\]]+]]/g, "");
    }
    if (settings.removeLinks) {
      normalized = normalized
        .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
        .replace(/\[\[([^|\]]+)\|([^\]]+)]]/g, "$2")
        .replace(/\[\[([^\]]+)]]/g, "$1");
    }
    if (settings.removeUrls) {
      normalized = normalized.replace(/https?:\/\/\S+|www\.\S+/g, "");
    }
    if (settings.removeTags) {
      normalized = normalized
        .replace(/(^|\s)#[\p{L}\p{N}_/-]+/gu, "$1")
        .replace(/^\s*tags:\s*\[[^\]]*]\s*$/gim, "")
        .replace(/^\s*tags:\s*.*$/gim, "");
    }

    // 移除 Markdown 分割线 (如 ---, ***, ___)
    normalized = normalized.replace(/^ *[-*_]{3,} *$/gm, "");

    normalized = this.removeSkippedLines(normalized, settings);

    // 将笔记标题作为语音开头（整篇朗读时且已启用，自动判断正文首行是否已包含标题避免重复）
    if (settings.includeTitleInAudio && noteTitle && noteTitle.trim()) {
      const trimmedTitle = noteTitle.trim();
      const firstLine = normalized.split("\n").find((line) => line.trim().length > 0) || "";

      const normalizeForCompare = (str: string) =>
        str
          .replace(/^#{1,6}\s+/, "")
          .replace(/^\s*[-*+]\s+/, "")
          .replace(/^\s*\d+\.\s+/, "")
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/[*_~`]/g, "")
          .replace(/[。！？，；：、.!?,;:"'“”‘’（）()[\]【】《》〈〉\s]/g, "")
          .toLowerCase();

      const normalizedFirstLine = normalizeForCompare(firstLine);
      const normalizedTitle = normalizeForCompare(trimmedTitle);

      const alreadyHasTitle =
        normalizedTitle.length > 0 &&
        (normalizedFirstLine === normalizedTitle ||
          (normalizedFirstLine.startsWith(normalizedTitle) && normalizedFirstLine.length <= normalizedTitle.length + 10));

      if (!alreadyHasTitle) {
        const pauseChar = settings.lineBreakPauseType === "comma" ? "，" : "。";
        const hasPunctuation = /[。！？，；：、.!?,;:][”’"'）)〕】〉》\]]*$/.test(trimmedTitle);
        const titleWithPause = hasPunctuation ? trimmedTitle : `${trimmedTitle}${pauseChar}`;
        normalized = normalized ? `${titleWithPause}\n\n${normalized}` : titleWithPause;
      }
    }

    let cleaned = normalized;
    if (settings.stripMarkdown) {
      cleaned = normalized
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/^\s*>+\s*/gm, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/_([^_]+)_/g, "$1")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    // Keep spoken list numbers, including Markdown-escaped dots (1\.).
    // A dot splits the number into a short fragment; the local frontend can
    // prepend another dot and interpret it as .1 (零点一). Use a list pause.
    // Horizontal whitespace only: never consume a newline or a decimal digit.
    cleaned = cleaned.replace(/^([ \t]*)(\d+)\\?\.[ \t]+(?=\S)/gm, "$1$2、");

    if (settings.addPauseAtLineBreaks) {
      const pauseChar = settings.lineBreakPauseType === "comma" ? "，" : "。";
      const punctuationRegex = /[。！？，；：、.!?,;:][”’"'）)〕】〉》\]]*$/;
      cleaned = cleaned
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (trimmed && !punctuationRegex.test(trimmed)) {
            return line + pauseChar;
          }
          return line;
        })
        .join("\n");
    }

    if (settings.optimizeAcronyms) {
      cleaned = cleaned.replace(/\b[A-Z]{2,}\b/g, (match) => {
        return match.split("").join(" ");
      });
    }

    if (settings.optimizeHyphens) {
      // 连字符与破折号规范化（通用规则，彻底杜绝读成“减”）：
      // 1. 规范化破折号：连续两个及以上的连字符/破折号转换为富有余韵的省略号微停顿
      cleaned = cleaned.replace(/[—–-]{2,}/g, "……");
      // 2. 独立带空格的连字符（作为破折号/同位语停顿，排除纯数字算式如 5 - 3）转为逗号微停顿
      cleaned = cleaned.replace(/(?<!\d)\s+[-－–—]\s+(?!\d)/g, "，");
      // 3. 汉字与汉字之间的连字符直接消除，不发音且无缝连读（如 "根-干-枝-叶" -> "根干枝叶"）
      cleaned = cleaned.replace(/(?<=[\p{Script=Han}])[-－–—](?=[\p{Script=Han}])/gu, "");
      // 4. 汉字与字母/数字之间的连字符直接消除（如 "AI-原生" -> "AI原生", "第-1名" -> "第1名"）
      cleaned = cleaned.replace(/(?<=[\p{Script=Han}])[-－–—](?=[a-zA-Z0-9])|(?<=[a-zA-Z0-9])[-－–—](?=[\p{Script=Han}])/gu, "");
      // 5. 英文字母与英文字母之间的连字符转为空格（如 "end-to-end" -> "end to end"）
      cleaned = cleaned.replace(/(?<=[a-zA-Z])[-－–—](?=[a-zA-Z])/gu, " ");
      // 6. 字母与数字之间的连字符转为空格（如 "GPT-4" -> "GPT 4"）
      cleaned = cleaned.replace(/(?<=[a-zA-Z])[-－–—](?=\d)|(?<=\d)[-－–—](?=[a-zA-Z])/gu, " ");
    }

    if (settings.provider === "gptsovits") {
      cleaned = verbalizeYearDurations(verbalizeExplicitClockTimes(cleaned));
      // The local Chinese frontend splits 1,000 into "一" and "零".
      // Remove only valid thousands grouping before either layer splits text.
      cleaned = cleaned.replace(/\d(?:[\d,]*\d)?(?:\.\d+)?/g, (number, offset: number, source: string) => {
        // A comma can be the fractional-second separator in a media timecode.
        if (/\d\s*[:：]\s*$/.test(source.slice(0, offset))) return number;
        return /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(number) ? number.replace(/,/g, "") : number;
      });
    }

    if (settings.addSpaceAfterPunctuation) {
      cleaned = cleaned.replace(/([。！？，；：、.!?,;:])(?![ \t\n\r])/g,
        (match: string, punctuation: string, offset: number, source: string) => {
          // Keep decimals, grouped numbers, times and numeric versions intact.
          // Splitting 3.14 into "3. 14" changes the input to the speech frontend.
          if (/[.,:：]/.test(punctuation) && /\d/.test(source.charAt(offset - 1)) && /\d/.test(source.charAt(offset + 1))) {
            return match;
          }
          return `${punctuation} `;
        });
    }

    // 过滤与优化 Markdown 元数据与特殊符号，避免杂音与奇怪发音:
    // 1. 过滤开头的作者/贡献者等元数据行 (如 "作者：@rwayne"、"Author: xxx")
    cleaned = cleaned.replace(/^[#\s]*(?:作者|Author|来源|Source)[：:][^\n]*$/gim, "");
    // 2. 剥离行内社交用户名中的 @ 符号 (如 "@rwayne" -> "rwayne")，防止被误判为英语拼读符号产生畸变怪音
    cleaned = cleaned.replace(/@([a-zA-Z0-9_\u4e00-\u9fa5]+)/g, "$1");

    if (settings.provider === "gptsovits") {
      const isMengyan = settings.gptsovitsVoicePreset?.startsWith("mengyan");
      const isLiufei = settings.gptsovitsVoicePreset?.startsWith("liufei") || !settings.gptsovitsVoicePreset;

      if (isMengyan) {
        // 孟岩播客专属韵律增强:
        // 1. 常见转折词与深度连接词前自动注入微停顿气口 (若前面无标点)，激发沉思慢调
        cleaned = cleaned.replace(/([^。！？，；：、\n\s])(但是|然而|其实|也就是说|这意味着|在我看来|对我而言)/g, "$1，$2");
        // 2. 将口语中省略主语的短转折 (如 "，但也是") 优化为更符合中文抑扬顿挫的连贯流向 (如 "，但这也是")
        cleaned = cleaned.replace(/([，,])\s*但也是/g, "$1但这也是");
      } else if (isLiufei) {
        // 刘飞《三五环》播客专属松弛韵律增强:
        // 1. 口语连词、转折与设问思考词前自动注入微停顿气口 (若前面无标点)，唤醒自然闲聊与生动起伏
        cleaned = cleaned.replace(/([^。！？，；：、\n\s])(就是说|其实|然后呢|比如说|某种意义上|我觉得|我经常觉得|坦白讲|反过来说)/g, "$1，$2");
        // 2. 句末口语反问或确认词前增加柔和停顿气口，还原与听众随性交流的松弛感
        cleaned = cleaned.replace(/([^。！？，；：、\n\s])(对吧|是不是|明白吧)/g, "$1，$2");
      }
    }

    return cleaned;
  }

  private removeSkippedLines(text: string, settings = this.settings) {
    const patterns = settings.skipLinePatterns
      .split("\n")
      .map((pattern) => pattern.trim())
      .filter(Boolean)
      .map((pattern) => {
        try {
          return new RegExp(pattern, "iu");
        } catch (error) {
          console.warn(`Invalid Note TTS skip pattern: ${pattern}`, error);
          return null;
        }
      })
      .filter((pattern): pattern is RegExp => Boolean(pattern));

    if (!patterns.length) {
      return text;
    }

    return text
      .split("\n")
      .filter((line) => !patterns.some((pattern) => pattern.test(line.trim())))
      .join("\n");
  }

  private getGenerationChunks(text: string, limit: number, provider: ProviderId = this.settings.provider): string[] {
    if (provider === "gptsovits" && limit > 0) return splitLocalNarration(text, limit);
    if (!(limit > 0 && text.length > limit)) return [text];
    const max = Math.max(80, provider === "volcengine" ? Math.min(limit, 800) : limit);
    const chunks = splitTextForTts(text, max);
    return chunks.length ? chunks : [text];
  }

  private createGenerationLog(text: string, mode: GenerationLog["mode"], sourceFile?: TFile, provider = this.settings.provider, settings = this.settings): GenerationLog {
    const s = settings;
    const now = new Date().toISOString();
    const log: GenerationLog = {
      version: 1, id: createUuid(), startedAt: now, updatedAt: now,
      durationMs: 0, durationBasis: "monotonic", status: "running", mode,
      sourcePath: sourceFile?.path, provider,
      model: "由自定义接口决定", voiceId: "unknown", voiceName: "由请求模板或服务端决定",
      characterCount: Array.from(text).length,
      chunkCount: mode === "preview" ? 1 : this.getGenerationChunks(text,
        Number(provider === "custom" ? s.customChunkCharacters : s.chunkCharacters) || 0, provider).length,
    };
    if (provider === "gptsovits") {
      const config = this.getGptSoVitsConfig(settings);
      log.model = "GPT-SoVITS";
      log.voiceId = s.gptsovitsVoicePreset;
      log.voiceName = GPTSOVITS_VOICES.find(v => v.id === log.voiceId)?.name || log.voiceId;
      log.modelWeights = { gpt: config.targetGptWeight || "服务端当前模型", sovits: config.targetSovitsWeight || "服务端当前模型" };
      log.referenceAudio = config.refAudio;
    } else if (provider === "volcengine") {
      log.model = s.volcengineCluster?.trim() || "volcano_tts";
      log.voiceId = s.volcengineVoiceType === "custom" ? s.volcengineCustomVoiceType.trim() : s.volcengineVoiceType;
      log.voiceName = VOLCENGINE_VOICES.find(v => v.id === log.voiceId)?.name || log.voiceId;
    } else if (provider === "minimax") {
      log.model = s.minimaxModel;
      log.voiceId = log.voiceName = s.minimaxVoiceId;
    } else if (provider === "replicate") {
      log.model = s.replicateModel || REPLICATE_MINIMAX_MODEL;
      if (log.model === REPLICATE_MINIMAX_MODEL) {
        try { log.voiceId = log.voiceName = this.getReplicateMiniMaxVoiceId(settings); }
        catch { log.voiceId = log.voiceName = "未配置自定义音色"; }
      }
      else log.model += s.replicateVersion ? `@${s.replicateVersion}` : "";
    }
    if (provider === "custom" || (provider === "replicate" && s.replicateModel !== REPLICATE_MINIMAX_MODEL)) {
      try {
        const body = renderJsonTemplate(provider === "custom" ? s.customBodyTemplate : s.replicateInputTemplate, "");
        const model = body?.model;
        const voice = body.voice_id || getByPath(body, "voice_setting.voice_id") || body.voice;
        if (provider === "custom" && typeof model === "string") log.model = model;
        if (typeof voice === "string") log.voiceId = log.voiceName = voice;
      } catch { /* Keep unknown metadata; the actual request will report invalid templates. */ }
    }
    return log;
  }

  private generationError(error: unknown, settings = this.settings): string {
    let message = errorMessage(error);
    // Do not copy credentials or signed download URLs from provider errors into the vault.
    const secrets = [settings.volcengineAppId, settings.volcengineAccessToken,
      settings.minimaxApiKey, settings.replicateApiToken];
    try {
      const headers = JSON.parse(settings.customHeaders || "{}") as Record<string, unknown>;
      for (const value of Object.values(headers)) {
        if (typeof value === "string") secrets.push(value, value.replace(/^Bearer\s+/i, ""));
      }
    } catch { /* Invalid templates are reported by the request itself. */ }
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
      message = message.split(secret).join("[redacted]");
    }
    return message.replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]").slice(0, 1500);
  }

  private async writeGenerationLog(log: GenerationLog): Promise<void> {
    const folder = `TTS Logs/${log.startedAt.slice(0, 7)}`;
    const path = `${folder}/${log.startedAt.replace(/[:.]/g, "-")}-${log.id}.json`;
    const content = JSON.stringify(log, null, 2) + "\n";
    const write = this.generationLogWriteQueue.then(async () => {
      await ensureFolder(this.app, folder);
      await this.app.vault.adapter.write(path, content);
    });
    this.generationLogWriteQueue = write.catch(() => {});
    try {
      await write;
    } catch (error) {
      console.warn("写入音频生成日志失败:", error);
      new Notice("音频生成日志写入失败，请检查仓库空间和写入权限。", 8000);
    }
  }

  private async runLoggedGeneration<T>(text: string, mode: GenerationLog["mode"], sourceFile: TFile | undefined,
    request: (log: GenerationLog) => Promise<T>, provider = this.settings.provider, settings = this.settings, task?: GenerationTask): Promise<{ value: T; durationMs: number }> {
    const log = this.createGenerationLog(text, mode, sourceFile, provider, settings);
    this.activeGenerationIds.add(log.id);
    if (task) task.logId = log.id;
    const started = performance.now();
    let value: T;
    try {
      await this.writeGenerationLog(log);
      value = await request(log);
      log.status = "success";
    } catch (error) {
      const pending = this.pendingTasks.some(task => task.generationLog?.id === log.id);
      log.status = pending ? "pending" : error instanceof PendingTaskError && log.outputPath ? "success" : "failed";
      log.error = this.generationError(error, settings);
      if (pending || error instanceof PendingTaskError) {
        throw new PendingTaskError(`${pending ? "后台任务待完成，可稍后检查。" : ""}${errorMessage(error)} 本次已用时 ${formatGenerationDuration(performance.now() - started)}。`);
      }
      throw error;
    } finally {
      log.durationMs = Math.max(0, Math.round(performance.now() - started));
      log.updatedAt = new Date().toISOString();
      if (log.status !== "pending") log.finishedAt = log.updatedAt;
      await this.writeGenerationLog(log);
      this.activeGenerationIds.delete(log.id);
    }
    return { value, durationMs: log.durationMs };
  }

  private async generateAndSaveAudio(text: string, file: TFile, mode: "note" | "selection" | "batch", status?: TtsStatusModal, onSave?: () => void, task?: GenerationTask) {
    const settings = task?.settings || { ...this.settings };
    let player: ProgressiveAudioPlayer | undefined;
    let previewUnavailable = false;
    const onChunk: AudioChunkListener | undefined = mode === "batch" ? undefined : (audio, index, count) => {
      if (count < 2 || this.unloading || previewUnavailable) return;
      try {
        if (!player) {
          if (index !== 0 || this.app.workspace?.getActiveFile()?.path !== file.path) return;
          this.earlyPlayer?.destroy();
          this.activeFloatingPlayer?.destroy();
          document.querySelectorAll<HTMLAudioElement>(".podvoice-card-audio, .note-tts-modal audio").forEach(el => el.pause());
          player = new ProgressiveAudioPlayer(this, file, count);
          this.earlyPlayer = player;
          status?.close();
          this.refreshAllInlineButtonsDebounced(60);
        }
        player.append(audio, index);
      } catch (error) {
        previewUnavailable = true;
        player?.destroy();
        console.warn("提前播放不可用，继续生成完整音频:", error);
        new Notice("提前播放暂不可用，完整音频仍在生成。");
      }
    };
    try {
      const result = await this.runLoggedGeneration(text, mode, file, async (log) => {
        const audio = await this.generateAudio(text, status, file, log, onChunk, settings, task);
        log.outputPath = audio.vaultPath;
        onSave?.();
        status?.setStatus("正在保存音频文件...");
        const saved = await this.saveAudioFile(file, audio, settings, task);
        if (mode !== "batch") this.manualCompletedPaths.add(file.path);
        log.outputPath = saved.path;
        return saved;
      }, settings.provider, settings, task);
      player?.complete(result.value);
      return { ...result, earlyPlayback: Boolean(player && !previewUnavailable) };
    } catch (error) {
      player?.fail();
      throw error;
    }
  }

  private async updatePendingGenerationLog(task: PendingTtsTask, status: GenerationLog["status"], outputPath?: string, error?: unknown) {
    const log = task.generationLog;
    if (!log) return; // Older pending tasks have no trustworthy model/start metadata.
    log.status = status;
    log.updatedAt = new Date().toISOString();
    log.durationMs = Math.max(0, Date.now() - Date.parse(log.startedAt));
    log.durationBasis = "wall-clock";
    log.outputPath = outputPath || log.outputPath;
    if (status === "success" || status === "failed") log.finishedAt = log.updatedAt;
    if (error !== undefined) log.error = this.generationError(error);
    else delete log.error;
    await this.writeGenerationLog(log);
    if (status === "success") new Notice(`「${task.sourcePath}」语音已生成，本次用时 ${formatGenerationDuration(log.durationMs)}（含后台等待）。`);
  }

  private async generateAudio(text: string, status?: TtsStatusModal, sourceFile?: TFile, generationLog?: GenerationLog, onChunk?: AudioChunkListener, settings = { ...this.settings }, task?: GenerationTask): Promise<AudioResult> {
    return this.trackAudioRequest(() => this.generateAudioForProvider(text, status, sourceFile, generationLog, onChunk, settings, task));
  }

  private async trackAudioRequest(request: () => Promise<AudioResult>): Promise<AudioResult> {
    this.activeAudioRequests++;
    try {
      return await request();
    } finally {
      this.activeAudioRequests--;
    }
  }

  private async generateAudioForProvider(text: string, status?: TtsStatusModal, sourceFile?: TFile, generationLog?: GenerationLog, onChunk?: AudioChunkListener, settings = { ...this.settings }, task?: GenerationTask): Promise<AudioResult> {
    if (settings.provider === "volcengine") {
      return this.generateWithVolcengine(text, status, settings);
    }
    if (settings.provider === "gptsovits") {
      return this.generateWithGptSoVits(text, status, onChunk, settings, task);
    }
    if (settings.provider === "minimax") {
      return this.generateWithMiniMax(text, status, settings);
    }
    if (settings.provider === "replicate") {
      return this.generateWithReplicate(text, status, settings);
    }
    return this.generateWithCustomProvider(text, status, sourceFile, generationLog, settings);
  }

  async testGptSoVitsVoice(): Promise<AudioResult> {
    return this.runGenerationTask("manual", undefined, task => this.testGptSoVitsVoiceNow(task.settings!));
  }

  private async testGptSoVitsVoiceNow(settings: NoteTtsSettings): Promise<AudioResult> {
    const isMengyan = settings.gptsovitsVoicePreset?.startsWith("mengyan");
    const testText = isMengyan
      ? "你好，我是孟岩，欢迎收听无人知晓。很高兴在听笔记中和你相遇。"
      : "欢迎收听三五环。大家好，我是刘飞，很高兴在听笔记中和你相遇。";
    const result = await this.runLoggedGeneration(testText, "preview", undefined,
      () => this.trackAudioRequest(() => this.requestGptSoVitsAudio(testText, undefined, settings)), "gptsovits", settings);
    new Notice(`试听语音已生成，本次用时 ${formatGenerationDuration(result.durationMs)}。`);
    return result.value;
  }

  private async generateWithGptSoVits(text: string, status?: TtsStatusModal, onChunk?: AudioChunkListener, settings = { ...this.settings }, task?: GenerationTask): Promise<AudioResult> {
    const chunkCharacters = Number(settings.chunkCharacters) || 0;
    if (chunkCharacters > 0) {
      return this.generateWithGptSoVitsChunks(text, chunkCharacters, status, onChunk, settings, task);
    }
    return this.requestGptSoVitsAudio(text, status, settings);
  }

  private async generateWithGptSoVitsChunks(text: string, chunkCharacters: number, status?: TtsStatusModal, onChunk?: AudioChunkListener, settings = { ...this.settings }, task?: GenerationTask): Promise<AudioResult> {
    const chunks = this.getGenerationChunks(text, chunkCharacters, "gptsovits");
    if (chunks.length <= 1) {
      return this.requestGptSoVitsAudio(text, status, settings);
    }

    const audios: AudioResult[] = [];
    for (let index = 0; index < chunks.length; index++) {
      status?.setStatus(`GPT-SoVITS 正在生成语音小段 ${index + 1}/${chunks.length}...`);
      await this.batchCheckpoint(task);
      const audio = await this.requestGptSoVitsAudio(chunks[index], status, settings);
      audios.push(audio);
      onChunk?.(audio, index, chunks.length);
    }

    await this.batchCheckpoint(task);
    return combineAudioResults(audios, "GPT-SoVITS", 0.5);
  }

  private getGptSoVitsConfig(settings = this.settings) {
    let refAudio = "reference_audio/liufei_02_chat.wav";
    let promptText = "而关于折叠屏手机的一些讨论本身就挺有意思的。";
    let promptLang = "zh";
    let targetGptWeight = "GPT_weights_v2/liufei-e15.ckpt";
    let targetSovitsWeight = "SoVITS_weights_v2/liufei_clean_20260930_e2_s160.pth";

    const isMengyan = settings.gptsovitsVoicePreset?.startsWith("mengyan");

    if (settings.gptsovitsVoicePreset === "mengyan_acoustic_candidate") {
      refAudio = "reference_audio/mengyan_03_philosophy.wav";
      promptText = "像是在一个巨大的房间里面进行搜索。那终其一生，我们可能只能了解这个巨大房间的非常非常有限的一个角落。";
      promptLang = "zh";
      targetGptWeight = "GPT_weights_v2/mengyan_v2-e25.ckpt";
      targetSovitsWeight = "SoVITS_weights_v2/mengyan_clean_20260930_e2_s166.pth";
    } else if (settings.gptsovitsVoicePreset === "custom") {
      refAudio = settings.gptsovitsCustomRefAudio?.trim() || refAudio;
      promptText = settings.gptsovitsCustomPromptText?.trim() || promptText;
      promptLang = settings.gptsovitsCustomPromptLang?.trim() || "zh";
      targetGptWeight = "";
      targetSovitsWeight = "";
    }

    return { refAudio, promptText, promptLang, targetGptWeight, targetSovitsWeight, isMengyan };
  }

  private async requestGptSoVitsAudio(text: string, status?: TtsStatusModal, settings = { ...this.settings }): Promise<AudioResult> {
    // The local pipeline has mutable shared weights. Serialize each complete request,
    // allowing independent notes to alternate chunks without changing a running model.
    const request = this.localAudioQueue.then(() => {
      if (this.unloading) throw new Error("插件已卸载，停止生成。");
      return this.requestGptSoVitsAudioNow(text, status, settings);
    });
    this.localAudioQueue = request.then(() => {}, () => {});
    return request;
  }

  private async requestGptSoVitsAudioNow(text: string, status: TtsStatusModal | undefined, settings: NoteTtsSettings): Promise<AudioResult> {
    const endpoint = (settings.gptsovitsEndpoint || "http://127.0.0.1:9880/tts").trim();
    const { refAudio, promptText, promptLang, targetGptWeight, targetSovitsWeight, isMengyan } = this.getGptSoVitsConfig(settings);

    // /tts validates both explicit paths and reuses matching loaded weights.
    // Separate /set_* calls force reload even when the service already has this voice.
    const isLiufei = !isMengyan;

    // 针对孟岩与刘飞音色的广播级双旗舰增强 (Multi-Reference Tone Fusion + Precision Sampling)：
    // 1. 多参考音频融合 (主叙事切片 + 辅助闲聊/展开切片)，提取全方位立体音色指纹，锁定播客真实声线
    // 2. 区分播客风格的差异化采样参数：刘飞松弛灵动，孟岩温厚深沉
    const auxRefAudios = isMengyan
      ? [
          "reference_audio/mengyan_02_chat.wav",
          "dataset/mengyan/wavs/mengyan_raw_6min.wav_0008983040_0009070720.wav",
        ]
      : [
          "dataset/liufei/wavs/liufei_raw_6min.wav_0000128000_0000342400.wav",
          "dataset/liufei/wavs/liufei_raw_6min.wav_0007375680_0007662400.wav",
        ];
    const defaultSpeed = 1.0;
    const defaultTemperature = isMengyan ? 0.82 : 0.75;
    const defaultTopP = isMengyan ? 0.95 : 0.85;
    const defaultTopK = isMengyan ? 15 : 15;
    const defaultSplitMethod = "cut_podcast"; // 本地服务按标点切句，保留短句与标题边界
    const defaultPause = isMengyan ? 0.35 : 0.28; // 逗号与分句自适应呼吸停顿基准值
    const defaultRepetitionPenalty = isMengyan ? 1.25 : 1.28;

    // 如果用户在设置中保持默认 1.0，则采用音色专属的播客黄金语速 1.0
    const effectiveSpeed =
      settings.gptsovitsSpeed != null && settings.gptsovitsSpeed !== 1
        ? Number(settings.gptsovitsSpeed)
        : defaultSpeed;

    // 尊重用户填写的采样参数；默认值仅用于未设置时。
    const effectiveTemperature =
      settings.gptsovitsTemperature != null
        ? Number(settings.gptsovitsTemperature)
        : defaultTemperature;
    const effectiveTopP =
      settings.gptsovitsTopP != null
        ? Number(settings.gptsovitsTopP)
        : defaultTopP;
    const effectiveTopK =
      settings.gptsovitsTopK != null
        ? Number(settings.gptsovitsTopK)
        : defaultTopK;

    const payload: Record<string, any> = {
      text,
      text_lang: "zh",
      ref_audio_path: refAudio,
      gpt_weights_path: targetGptWeight || undefined,
      sovits_weights_path: targetSovitsWeight || undefined,
      aux_ref_audio_paths: auxRefAudios,
      prompt_text: promptText,
      prompt_lang: promptLang,
      top_k: effectiveTopK,
      top_p: effectiveTopP,
      temperature: effectiveTemperature,
      repetition_penalty: defaultRepetitionPenalty,
      text_split_method: defaultSplitMethod,
      batch_size: 2,
      parallel_infer: true,
      independent_decode: true, // Keep acoustic attention within each sentence; retain batched semantic inference.
      split_bucket: true,
      speed_factor: effectiveSpeed,
      fragment_interval: defaultPause,
      media_type: "wav",
      streaming_mode: false,
      mastering: true, // 50Hz 高通、11.5kHz 低通和峰值归一化；不等同于响度母带处理
    };

    status?.setStatus("正在请求本地 GPT-SoVITS 大模型合成语音...");
    try {
      const response = await requestUrlWithRetries(
        {
          url: endpoint,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
        {
          attempts: 2,
          baseDelayMs: 1500,
          onRetry: (attempt) => status?.setStatus(`本地服务响应等待中，正在重试... ${attempt}/2`),
        }
      );

      const contentType = getHeader(response.headers, "content-type");
      if (response.arrayBuffer?.byteLength && !looksLikeJson(contentType)) {
        return {
          data: response.arrayBuffer,
          extension: "wav",
          mimeType: "audio/wav",
        };
      }

      const message: unknown = (response.json as { message?: unknown } | null)?.message;
      if (typeof message === "string" && message) {
        throw new Error(message);
      }
      throw new Error("服务端未返回有效的音频数据。");
    } catch (error) {
      const body = (error as { response?: { json?: { message?: string }; text?: string } })?.response;
      const detail = body?.json?.message || body?.text;
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("Failed to fetch") || msg.includes("ECONNREFUSED") || msg.includes("connect")) {
        throw new Error(
          `无法连接到本地 GPT-SoVITS 服务 (${endpoint})。\n请确认已在终端执行: ./run_api.sh 启动服务。`
        );
      }
      if (detail) {
        throw new Error(`GPT-SoVITS 服务返回：${detail}`);
      }
      throw error;
    }
  }

  async testVolcengineVoice(): Promise<AudioResult> {
    return this.runGenerationTask("manual", undefined, task => this.testVolcengineVoiceNow(task.settings!));
  }

  private async testVolcengineVoiceNow(settings: NoteTtsSettings): Promise<AudioResult> {
    const text = "你好！这是听笔记插件的语音测试，说明你的火山引擎配置已完全正常。";
    const result = await this.runLoggedGeneration(text, "preview", undefined,
      () => this.trackAudioRequest(() => this.requestVolcengineAudio(text, settings)), "volcengine", settings);
    new Notice(`试听语音已生成，本次用时 ${formatGenerationDuration(result.durationMs)}。`);
    return result.value;
  }

  private async generateWithVolcengine(text: string, status?: TtsStatusModal, settings = { ...this.settings }): Promise<AudioResult> {
    if (!settings.volcengineAppId?.trim() || !settings.volcengineAccessToken?.trim()) {
      throw new Error("请先在设置中填写火山引擎的 AppID 和 Access Token。");
    }

    const chunkCharacters = Number(settings.chunkCharacters) || 0;
    if (chunkCharacters > 0 && text.length > chunkCharacters) {
      return this.generateWithVolcengineChunks(text, chunkCharacters, status, settings);
    }

    return this.requestVolcengineAudio(text, settings);
  }

  private async generateWithVolcengineChunks(text: string, chunkCharacters: number, status?: TtsStatusModal, settings = { ...this.settings }): Promise<AudioResult> {
    const chunks = this.getGenerationChunks(text, chunkCharacters, "volcengine");
    if (chunks.length <= 1) {
      return this.requestVolcengineAudio(chunks[0] || text, settings);
    }

    const audios: AudioResult[] = [];
    for (let index = 0; index < chunks.length; index++) {
      status?.setStatus(`火山引擎正在生成语音 (${index + 1}/${chunks.length})...`);
      audios.push(await this.requestVolcengineAudio(chunks[index], settings));
    }

    return combineAudioResults(audios, "火山引擎");
  }

  private async requestVolcengineAudio(text: string, settings = this.settings): Promise<AudioResult> {
    const trimmed = text.trim();
    if (!trimmed || !/[\p{L}\p{N}]/u.test(trimmed)) {
      throw new Error("当前分段没有包含可朗读的文字内容。");
    }

    const voice = settings.volcengineVoiceType === "custom"
      ? (settings.volcengineCustomVoiceType || "BV001_streaming")
      : (settings.volcengineVoiceType || "BV001_streaming");

    const token = settings.volcengineAccessToken.trim();
    const rawToken = token.replace(/^Bearer[;\s]+/i, "");
    const authHeader = token.startsWith("Bearer") ? token : `Bearer;${token}`;

    const response = await requestUrlWithRetries({
      url: settings.volcengineEndpoint || "https://openspeech.bytedance.com/api/v1/tts",
      method: "POST",
      headers: {
        Authorization: authHeader,
        "X-Api-Key": rawToken,
        "X-Api-App-Key": settings.volcengineAppId.trim(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        app: {
          appid: settings.volcengineAppId.trim(),
          token: rawToken,
          cluster: settings.volcengineCluster?.trim() || "volcano_tts",
        },
        user: {
          uid: "obsidian_user",
        },
        audio: {
          voice_type: voice,
          encoding: "mp3",
          speed_ratio: Number(settings.volcengineSpeed) || 1.0,
          volume_ratio: Number(settings.volcengineVolume) || 1.0,
          pitch_ratio: Number(settings.volcenginePitch) || 1.0,
        },
        request: {
          reqid: createUuid(),
          text: trimmed,
          text_type: "plain",
          operation: "query",
        },
      }),
    }, {
      attempts: 3,
      baseDelayMs: 1500,
      errorPrefix: "火山引擎语音合成请求失败",
    });

    const payload = response.json as { code?: number; message?: string; data?: string };
    if (!payload) {
      throw new Error("火山引擎未返回有效的 JSON 数据。");
    }
    if (payload.code !== 3000) {
      throw new Error(`火山引擎返回错误 [${payload.code}]: ${payload.message || "合成失败"}`);
    }
    const audioBase64 = payload.data;
    if (!audioBase64) {
      throw new Error("火山引擎响应中未包含音频数据。");
    }

    return {
      data: base64ToArrayBuffer(audioBase64),
      extension: "mp3",
      mimeType: "audio/mpeg",
    };
  }

  private async generateWithMiniMax(text: string, status?: TtsStatusModal, settings = { ...this.settings }): Promise<AudioResult> {
    if (!settings.minimaxApiKey) {
      throw new Error("请先在设置里填写 MiniMax API Key。");
    }

    const chunkCharacters = Number(settings.chunkCharacters) || 0;
    if (chunkCharacters > 0 && text.length > chunkCharacters) {
      return this.generateWithMiniMaxChunks(text, chunkCharacters, status, settings);
    }

    return this.requestMiniMaxAudio(text, settings);
  }

  private async generateWithMiniMaxChunks(text: string, chunkCharacters: number, status?: TtsStatusModal, settings = { ...this.settings }): Promise<AudioResult> {
    const chunks = this.getGenerationChunks(text, chunkCharacters, settings.provider);
    if (chunks.length <= 1) {
      return this.requestMiniMaxAudio(text, settings);
    }

    const audios: AudioResult[] = [];
    for (let index = 0; index < chunks.length; index++) {
      status?.setStatus(`MiniMax 正在生成分段 ${index + 1}/${chunks.length}...`);
      audios.push(await this.requestMiniMaxAudio(chunks[index], settings));
    }

    return combineAudioResults(audios, "MiniMax");
  }

  private async requestMiniMaxAudio(text: string, settings = this.settings): Promise<AudioResult> {
    const response = await requestUrl({
      url: settings.minimaxEndpoint,
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.minimaxApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: settings.minimaxModel,
        text,
        stream: false,
        output_format: "hex",
        language_boost: settings.minimaxLanguageBoost || "auto",
        voice_setting: {
          voice_id: settings.minimaxVoiceId,
          speed: Math.round(settings.minimaxSpeed),
          vol: Math.round(settings.minimaxVolume),
          pitch: Math.round(settings.minimaxPitch),
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: "mp3",
          channel: 1,
        },
      }),
    });

    const payload = response.json as { base_resp?: { status_code?: number; status_msg?: string }; data?: { audio?: string } };
    if (payload?.base_resp?.status_code !== 0) {
      throw new Error(payload?.base_resp?.status_msg || "MiniMax 返回了错误。");
    }

    const audioHex = payload?.data?.audio;
    if (!audioHex) {
      throw new Error("MiniMax 响应中没有音频数据。");
    }

    return {
      data: hexToArrayBuffer(audioHex),
      extension: "mp3",
      mimeType: "audio/mpeg",
    };
  }

  private async generateWithReplicate(text: string, status?: TtsStatusModal, settings = { ...this.settings }): Promise<AudioResult> {
    if (!settings.replicateApiToken) {
      throw new Error("请先在设置里填写 Replicate API Token。");
    }

    const chunkCharacters = Number(settings.chunkCharacters) || 0;
    if (chunkCharacters > 0 && text.length > chunkCharacters) {
      return this.generateWithReplicateChunks(text, chunkCharacters, status, settings);
    }

    return this.requestReplicateAudio(text, status, settings);
  }

  private async generateWithReplicateChunks(text: string, chunkCharacters: number, status?: TtsStatusModal, settings = { ...this.settings }): Promise<AudioResult> {
    const chunks = this.getGenerationChunks(text, chunkCharacters, settings.provider);
    if (chunks.length <= 1) {
      return this.requestReplicateAudio(text, status, settings);
    }

    const audios: AudioResult[] = [];
    for (let index = 0; index < chunks.length; index++) {
      status?.setStatus(`Replicate 正在生成分段 ${index + 1}/${chunks.length}...`);
      audios.push(await this.requestReplicateAudio(chunks[index], status, settings));
    }

    return combineAudioResults(audios, "Replicate");
  }

  private async requestReplicateAudio(text: string, status?: TtsStatusModal, settings = this.settings): Promise<AudioResult> {
    const model = settings.replicateModel || REPLICATE_MINIMAX_MODEL;
    const input = this.createReplicateInput(text, model, settings);
    const url = this.createReplicatePredictionUrl(model);
    const body = model === REPLICATE_MINIMAX_MODEL
      ? { input }
      : { version: settings.replicateVersion, input };

    if (model !== REPLICATE_MINIMAX_MODEL && !settings.replicateVersion) {
      throw new Error("请先在设置里填写 Replicate 模型 version。");
    }

    status?.setStatus("正在提交 Replicate 任务...");
    let prediction = await this.requestReplicateJson({
      url,
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.replicateApiToken}`,
        "Content-Type": "application/json",
        Prefer: "wait=60",
      },
      body: JSON.stringify(body),
    });

    prediction = await this.pollReplicatePrediction(prediction, status, settings);
    const outputUrl = findFirstUrl(prediction?.output);
    if (!outputUrl) {
      throw new Error("Replicate 输出里没有找到音频 URL。");
    }

    status?.setStatus("正在下载音频...");
    return this.downloadAudio(outputUrl);
  }

  private createReplicateInput(text: string, model: string, settings = this.settings) {
    if (model === REPLICATE_MINIMAX_MODEL) {
      const languageBoost = settings.replicateLanguageBoost === "auto"
        ? "None"
        : settings.replicateLanguageBoost || "None";
      const voiceId = this.getReplicateMiniMaxVoiceId(settings);

      return {
        text,
        pitch: Number.isFinite(settings.replicatePitch) ? settings.replicatePitch : 0,
        speed: clampNumber(settings.replicateSpeed, 0.5, 2, 1),
        volume: clampNumber(settings.replicateVolume, 0, 10, 1),
        bitrate: 128000,
        channel: "mono",
        emotion: settings.replicateEmotion || "auto",
        voice_id: voiceId,
        sample_rate: 32000,
        audio_format: "mp3",
        language_boost: languageBoost,
        subtitle_enable: false,
        english_normalization: false,
      };
    }

    return renderJsonTemplate(settings.replicateInputTemplate, text);
  }

  private getReplicateMiniMaxVoiceId(settings = this.settings) {
    if (settings.replicateVoiceId === REPLICATE_CUSTOM_VOICE) {
      const customVoiceId = settings.replicateCustomVoiceId.trim();
      if (!customVoiceId) {
        throw new Error("请选择一个内置音色，或填写 Custom voice ID。");
      }
      return customVoiceId;
    }

    return REPLICATE_MINIMAX_VOICES.includes(settings.replicateVoiceId)
      ? settings.replicateVoiceId
      : "Wise_Woman";
  }

  private createReplicatePredictionUrl(model: string) {
    if (model === REPLICATE_MINIMAX_MODEL) {
      return "https://api.replicate.com/v1/models/minimax/speech-2.8-turbo/predictions";
    }

    return "https://api.replicate.com/v1/predictions";
  }

  private async pollReplicatePrediction(prediction: ReplicatePrediction, status?: TtsStatusModal, settings = this.settings) {
    const getUrl = prediction?.urls?.get;
    if (!getUrl) {
      return prediction;
    }

    for (let attempt = 0; attempt < 60; attempt++) {
      status?.setStatus(`Replicate 正在生成语音... ${prediction.status || "starting"}`);
      if (prediction.status === "succeeded" || prediction.status === "successful") {
        return prediction;
      }
      if (prediction.status === "failed" || prediction.status === "canceled") {
        throw new Error(prediction.error || `Replicate prediction ${prediction.status}。`);
      }

      await sleep(1500);
      prediction = await this.requestReplicateJson({
        url: getUrl,
        method: "GET",
        headers: {
          Authorization: `Bearer ${settings.replicateApiToken}`,
        },
      });
    }

    throw new Error("Replicate 生成超时，请稍后重试。");
  }

  private async requestReplicateJson(options: Parameters<typeof requestUrl>[0]) {
    try {
      return (await requestUrl(options)).json as ReplicatePrediction;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const body = (error as { response?: { json?: unknown; text?: string } })?.response;
      const detail = body?.json ? JSON.stringify(body.json) : body?.text;
      throw new Error(detail ? `Replicate 请求失败：${detail}` : `Replicate 请求失败：${message}`);
    }
  }

  private async generateWithCustomProvider(text: string, status?: TtsStatusModal, sourceFile?: TFile, generationLog?: GenerationLog, settings = { ...this.settings }): Promise<AudioResult> {
    if (!settings.customEndpoint) {
      throw new Error("请先填写自定义 Provider Endpoint。");
    }

    const chunkCharacters = Number(settings.customChunkCharacters) || 0;
    if (chunkCharacters > 0 && text.length > chunkCharacters) {
      return this.generateWithCustomProviderChunks(text, chunkCharacters, status, settings);
    }

    return this.requestCustomProviderAudio(text, status, sourceFile, generationLog, settings);
  }

  private async generateWithCustomProviderChunks(text: string, chunkCharacters: number, status?: TtsStatusModal, settings = { ...this.settings }): Promise<AudioResult> {
    const chunks = this.getGenerationChunks(text, chunkCharacters, "custom");
    if (chunks.length <= 1) {
      return this.requestCustomProviderAudio(text, status, undefined, undefined, settings);
    }

    const audios: AudioResult[] = [];
    for (let index = 0; index < chunks.length; index++) {
      status?.setStatus(`正在生成分段 ${index + 1}/${chunks.length}...`);
      audios.push(await this.requestCustomProviderAudio(chunks[index], status, undefined, undefined, settings));
    }

    return combineAudioResults(audios, "Custom");
  }

  private async requestCustomProviderAudio(text: string, status?: TtsStatusModal, sourceFile?: TFile, generationLog?: GenerationLog, settings = { ...this.settings }): Promise<AudioResult> {
    const headers = renderHeaderTemplate(settings.customHeaders || "{}", text);
    const body = settings.customBodyTemplate
      ? JSON.stringify({
          ...renderJsonTemplate(settings.customBodyTemplate, text),
          filename: sourceFile?.basename || "Note TTS",
        })
      : undefined;

    status?.setStatus("正在提交本地语音任务...");
    const response = await requestUrlWithRetries(
      {
        url: settings.customEndpoint,
        method: settings.customMethod || "POST",
        headers,
        body,
      },
      {
        attempts: 5,
        baseDelayMs: 2000,
        onRetry: (attempt) => status?.setStatus(`提交请求超时，正在重试... ${attempt}/5`),
      }
    );

    const contentType = getHeader(response.headers, "content-type");
    if (response.arrayBuffer?.byteLength && !looksLikeJson(contentType)) {
      const mimeType = contentType || (looksLikeWav(response.arrayBuffer) ? "audio/wav" : "audio/mpeg");
      return {
        data: response.arrayBuffer,
        extension: extensionFromMime(mimeType),
        mimeType,
      };
    }

    const payload = response.json as ProviderTaskResponse;
    if (payload?.task_id || payload?.status_url) {
      return this.pollCustomProviderTask(payload, headers, status, sourceFile, text.length, generationLog);
    }

    const audioUrl = getByPath(payload, settings.customAudioUrlPath);
    if (typeof audioUrl === "string" && audioUrl) {
      return this.downloadAudio(audioUrl, headers);
    }

    const audioHex = getByPath(payload, settings.customAudioHexPath);
    if (typeof audioHex === "string" && audioHex) {
      return {
        data: hexToArrayBuffer(audioHex),
        extension: "mp3",
        mimeType: "audio/mpeg",
      };
    }

    const audioBase64 = getByPath(payload, settings.customAudioBase64Path);
    if (typeof audioBase64 === "string" && audioBase64) {
      return {
        data: base64ToArrayBuffer(audioBase64),
        extension: "mp3",
        mimeType: "audio/mpeg",
      };
    }

    throw new Error("自定义 Provider 响应中没有找到音频数据。");
  }

  private async pollCustomProviderTask(
    payload: ProviderTaskResponse,
    headers: Record<string, string>,
    status?: TtsStatusModal,
    sourceFile?: TFile,
    textLength = 0,
    generationLog?: GenerationLog
  ): Promise<AudioResult> {
    const statusUrl = payload?.status_url;
    if (typeof statusUrl !== "string" || !statusUrl) {
      throw new Error("Custom 异步任务缺少 status_url。");
    }
    const pending = sourceFile
      ? await this.rememberPendingTask(payload, headers, sourceFile, statusUrl, textLength, generationLog)
      : null;

    let transientFailures = 0;
    for (let attempt = 0; attempt < 240; attempt++) {
      status?.setStatus(`Mac mini 正在生成语音... ${attempt + 1}`);
      await sleep(5000);

      let task: ProviderTaskResponse;
      try {
        const response = await requestUrlWithRetries(
          {
            url: statusUrl,
            method: "GET",
            headers,
          },
          { attempts: 2, baseDelayMs: 1200 }
        );
        transientFailures = 0;
        task = response.json as ProviderTaskResponse;
      } catch (error) {
        transientFailures += 1;
        if (transientFailures >= 120) {
          throw new Error(`等待本地语音任务时连接连续中断：${errorMessage(error)}`);
        }
        status?.setStatus(`连接暂时中断，继续等待... ${transientFailures}/120`);
        continue;
      }

      if (task?.status === "succeeded") {
        const vaultPath = typeof task?.vault_path === "string" ? task.vault_path : undefined;
        if (vaultPath) {
          if (pending) {
            this.removePendingTask(pending.id);
            await this.saveSettings();
          }
          status?.setStatus("语音已保存到 iCloud，正在等待手机同步...");
          return {
            vaultPath,
            extension: extensionFromPath(vaultPath),
            mimeType: mimeFromExtension(extensionFromPath(vaultPath)),
          };
        }

        const audioUrl = task?.audio_url || payload?.audio_url;
        if (typeof audioUrl !== "string" || !audioUrl) {
          throw new Error("Custom 异步任务完成但缺少 audio_url。");
        }
        if (pending) {
          this.removePendingTask(pending.id);
          await this.saveSettings();
        }
        status?.setStatus("语音已生成，正在下载...");
        return this.downloadAudio(audioUrl, headers, status, numericValue(task?.m4a_bytes || task?.audio_bytes));
      }
      if (task?.status === "failed") {
        if (pending) {
          this.removePendingTask(pending.id);
          await this.saveSettings();
        }
        throw new Error(task?.error || "Custom 异步任务失败。");
      }
    }

    throw new Error("Custom 异步任务超时。");
  }

  private async rememberPendingTask(
    payload: ProviderTaskResponse,
    headers: Record<string, string>,
    sourceFile: TFile,
    statusUrl: string,
    textLength: number,
    generationLog?: GenerationLog
  ) {
    const id = String(payload?.task_id || statusUrl);
    const existing = this.pendingTasks.find((task) => task.id === id);
    if (existing) {
      return existing;
    }

    const task: PendingTtsTask = {
      id,
      sourcePath: sourceFile.path,
      statusUrl,
      audioUrl: typeof payload?.audio_url === "string" ? payload.audio_url : undefined,
      headers,
      created: Date.now(),
      textLength,
      generationLog,
    };
    this.pendingTasks.push(task);
    await this.saveSettings();
    return task;
  }

  private removePendingTask(id: string) {
    this.pendingTasks = this.pendingTasks.filter((task) => task.id !== id);
  }

  private async checkPendingTasks() {
    if (!this.pendingTasks.length) {
      new Notice("没有待下载的语音任务。");
      return;
    }

    const status = new TtsStatusModal(this.app);
    status.open();
    let completed = 0;
    let stillProcessing = 0;
    let lastSaved: TFile | null = null;

    for (const task of [...this.pendingTasks]) {
      // Do not race the foreground poll/save against the manual recovery command.
      if (task.generationLog && this.activeGenerationIds.has(task.generationLog.id)) {
        stillProcessing++;
        continue;
      }
      status.setStatus(`正在检查语音任务... ${completed + stillProcessing + 1}/${this.pendingTasks.length}`);
      try {
        const response = await requestUrlWithRetries(
          {
            url: task.statusUrl,
            method: "GET",
            headers: task.headers,
          },
          { attempts: 4, baseDelayMs: 1500, errorPrefix: "检查语音任务失败" }
        );
        const payload = response.json as ProviderTaskResponse;
        if (payload?.status === "failed") {
          await this.updatePendingGenerationLog(task, "failed", undefined, payload?.error || "后台任务失败");
          this.removePendingTask(task.id);
          console.warn("Pending Note TTS task failed:", payload?.error || task.id);
          continue;
        }
        if (payload?.status !== "succeeded") {
          await this.updatePendingGenerationLog(task, "pending");
          stillProcessing += 1;
          continue;
        }

        const vaultPath = typeof payload?.vault_path === "string" ? payload.vault_path : undefined;
        if (vaultPath) {
          const source = await this.waitForVaultFile(vaultPath, status, 15000);
          if (source) {
            lastSaved = source;
            completed += 1;
          } else {
            new Notice(`语音已保存在 Mac mini 的 iCloud：${vaultPath}`);
            stillProcessing += 1;
          }
          await this.updatePendingGenerationLog(task, "success", vaultPath);
          this.removePendingTask(task.id);
          continue;
        }

        const audioUrl = payload?.audio_url || task.audioUrl;
        if (typeof audioUrl !== "string" || !audioUrl) {
          throw new Error("语音任务已完成但缺少 audio_url。");
        }

        status.setStatus("正在下载已完成的语音...");
        const audio = await this.downloadAudio(audioUrl, task.headers, status, numericValue(payload?.m4a_bytes || payload?.audio_bytes));
        const source = this.app.vault.getAbstractFileByPath(task.sourcePath);
        if (!(source instanceof TFile)) {
          throw new Error(`找不到原始笔记：${task.sourcePath}`);
        }

        lastSaved = await this.saveAudioFile(source, audio);
        await this.updatePendingGenerationLog(task, "success", lastSaved.path);
        this.removePendingTask(task.id);
        completed += 1;
      } catch (error) {
        console.error(error);
        await this.updatePendingGenerationLog(task, "pending", undefined, error);
        stillProcessing += 1;
      }
    }

    await this.saveSettings();
    status.close();

    if (completed > 0) {
      new Notice(`已下载 ${completed} 个语音文件。`);
      if (lastSaved && this.settings.autoOpenPlayerAfterGenerate) {
        new AudioResultModal(this.app, lastSaved).open();
      }
      return;
    }

    new Notice(stillProcessing > 0 ? "语音还在生成，稍后再检查。" : "没有可下载的语音任务。");
  }

  private async downloadAudio(
    url: string,
    headers?: Record<string, string>,
    status?: TtsStatusModal,
    expectedBytes?: number
  ): Promise<AudioResult> {
    if (url.startsWith("data:")) {
      const [meta, encoded] = url.split(",", 2);
      const mimeType = meta.match(/^data:([^;]+)/)?.[1] || "audio/mpeg";
      return {
        data: base64ToArrayBuffer(encoded),
        extension: extensionFromMime(mimeType),
        mimeType,
      };
    }

    if (expectedBytes && expectedBytes > 768 * 1024) {
      const ranged = await this.downloadAudioInRanges(url, headers, expectedBytes, status);
      if (ranged) {
        return ranged;
      }
    }

    const response = await requestUrlWithRetries(
      { url, method: "GET", headers },
      {
        attempts: 30,
        baseDelayMs: 2000,
        errorPrefix: "下载音频时连接中断",
      }
    );

    const mimeType = getHeader(response.headers, "content-type") || "audio/mpeg";
    return {
      data: response.arrayBuffer,
      extension: extensionFromMime(mimeType),
      mimeType,
    };
  }

  private async downloadAudioInRanges(
    url: string,
    headers: Record<string, string> | undefined,
    expectedBytes: number,
    status?: TtsStatusModal
  ): Promise<AudioResult | null> {
    const chunkSize = 512 * 1024;
    const chunks: ArrayBuffer[] = [];
    let downloaded = 0;

    while (downloaded < expectedBytes) {
      const end = Math.min(downloaded + chunkSize - 1, expectedBytes - 1);
      const start = downloaded;
      const mergedHeaders = {
        ...(headers || {}),
        Range: `bytes=${start}-${end}`,
      };
      status?.setStatus(`语音已生成，正在分块下载... ${Math.floor(start / chunkSize) + 1}/${Math.ceil(expectedBytes / chunkSize)}`);

      try {
        const response = await requestUrlWithRetries(
          { url, method: "GET", headers: mergedHeaders },
          {
            attempts: 12,
            baseDelayMs: 1500,
            errorPrefix: "分块下载音频时连接中断",
          }
        );
        const contentRange = getHeader(response.headers, "content-range");
        if (!contentRange && response.arrayBuffer.byteLength > chunkSize + 4096) {
          return null;
        }
        chunks.push(response.arrayBuffer);
        downloaded += response.arrayBuffer.byteLength;
      } catch (error) {
        console.warn("Range download failed, falling back to normal audio download:", error);
        return null;
      }
    }

    const mimeType = "audio/mp4";
    return {
      data: concatenateArrayBuffers(chunks),
      extension: extensionFromMime(mimeType),
      mimeType,
    };
  }


  async getStorageStats() {
    const folder = normalizeFolder(this.settings.outputFolder);
    const audioFiles = this.app.vault.getFiles().filter((f) => {
      return (
        f.path.startsWith(folder + "/") &&
        (f.extension === "mp3" || f.extension === "m4a" || f.extension === "wav")
      );
    });

    let totalBytes = 0;
    for (const f of audioFiles) {
      totalBytes += f.stat.size || 0;
    }

    const allMdFiles = this.app.vault.getMarkdownFiles();
    const mdBaseNames = new Set(allMdFiles.map((m) => m.basename));

    const orphanFiles: TFile[] = [];
    for (const f of audioFiles) {
      const match = f.basename.match(/^(.*?)(?:-\d{4}-\d{2}-\d{2}T.*)?$/);
      const inferredNote = match ? match[1] : f.basename;
      if (!mdBaseNames.has(inferredNote)) {
        orphanFiles.push(f);
      }
    }

    return {
      count: audioFiles.length,
      totalBytes,
      orphanCount: orphanFiles.length,
      orphanFiles,
      audioFiles,
    };
  }

  private async removeSpeechTimingCache(audioPath: string) {
    const cachePath = audioPath + ".podvoice-timing.json";
    try {
      if (await this.app.vault.adapter.exists(cachePath)) await this.app.vault.adapter.remove(cachePath);
    } catch (error) { console.warn("清理语音时间戳失败:", error); }
  }

  async cleanOrphanAudios(): Promise<number> {
    const stats = await this.getStorageStats();
    let cleaned = 0;
    for (const file of stats.orphanFiles) {
      try {
        await this.app.vault.delete(file);
        await this.removeSpeechTimingCache(file.path);
        cleaned++;
      } catch (err) {
        console.warn("删除孤立音频失败:", file.path, err);
      }
    }
    return cleaned;
  }

  async clearAllAudios(): Promise<number> {
    const stats = await this.getStorageStats();
    let cleaned = 0;
    for (const file of stats.audioFiles) {
      try {
        await this.app.vault.delete(file);
        await this.removeSpeechTimingCache(file.path);
        cleaned++;
      } catch (err) {
        console.warn("清空音频失败:", file.path, err);
      }
    }
    return cleaned;
  }

  findExistingAudioForNote(file: TFile): TFile | null {
    const folder = normalizeFolder(this.settings.outputFolder);
    const cleanBasename = file.basename.replace(/[/:*?"<>|#^[\]]/g, "-").slice(0, 80);
    const extensions = ["mp3", "m4a", "wav"];

    // 0. 最优先且最直接：检查标准路径下的音频文件（如 TTS Audio/笔记名.mp3）
    for (const name of [cleanBasename, file.basename]) {
      for (const ext of extensions) {
        const standardPath = `${folder}/${name}.${ext}`;
        const standardFile = this.app.vault.getAbstractFileByPath(standardPath);
        if (standardFile instanceof TFile) {
          return standardFile;
        }
      }
    }

    // 1. 尝试从笔记 frontmatter 读取
    const cache = this.app.metadataCache.getFileCache(file);
    const fmKey = this.settings.frontmatterKey?.trim() || "audio";
    let rawFm: unknown = cache?.frontmatter?.[fmKey];
    if (rawFm === undefined && cache?.frontmatter) {
      // 容错：不区分大小写检索属性名（如 Audio、tts_audio、audio）
      const lowerKey = fmKey.toLowerCase();
      for (const [k, v] of Object.entries(cache.frontmatter)) {
        if (k.toLowerCase() === lowerKey || k.toLowerCase() === "audio") {
          rawFm = v;
          break;
        }
      }
    }

    // 展平多层数组（处理 YAML 中未加引号的 [[...]] 被解析为二维数组的情况）
    let fmVal = rawFm;
    while (Array.isArray(fmVal) && fmVal.length > 0) {
      fmVal = fmVal[0];
    }

    let targetPath: string | null = null;
    if (typeof fmVal === "string" && fmVal.trim()) {
      let s = fmVal.trim();
      const wikiMatch = s.match(/!?\[\[(.*?)\]\]/);
      if (wikiMatch) {
        s = wikiMatch[1];
      } else {
        const mdMatch = s.match(/\[.*?\]\((.*?)\)/);
        if (mdMatch) {
          s = mdMatch[1];
        }
      }
      // 去除别名和锚点，如 [[xxx.mp3|别名]] 或 [[xxx.mp3#...]]
      s = s.split("|")[0].split("#")[0].trim();
      s = s.replace(/^["']|["']$/g, "").trim();
      try {
        s = decodeURIComponent(s);
      } catch { /* Keep the original value when decoding or cleanup is unavailable. */ }
      targetPath = s;
    }

    if (targetPath) {
      const candidatePaths = [
        targetPath,
        `${folder}/${targetPath}`,
        targetPath.startsWith("/") ? targetPath.slice(1) : targetPath,
      ];
      for (const p of candidatePaths) {
        const direct = this.app.vault.getAbstractFileByPath(p);
        if (direct instanceof TFile) return direct;
      }
      const linked = this.app.metadataCache.getFirstLinkpathDest(targetPath, file.path);
      if (linked instanceof TFile) return linked;
    }

    // 2. 检查正文内嵌入或链接的音频（cache.embeds / cache.links）
    if (cache) {
      const candidates = [...(cache.embeds || []), ...(cache.links || [])];
      for (const item of candidates) {
        let link = item.link?.split("|")[0].split("#")[0].trim();
        if (link && /\.(mp3|m4a|wav)$/i.test(link)) {
          try {
            link = decodeURIComponent(link);
          } catch { /* Keep the original value when decoding or cleanup is unavailable. */ }
          const dest =
            this.app.metadataCache.getFirstLinkpathDest(link, file.path) ||
            this.app.vault.getAbstractFileByPath(link) ||
            this.app.vault.getAbstractFileByPath(`${folder}/${link}`);
          if (dest instanceof TFile) return dest;
        }
      }
    }

    // 3. 尝试在输出目录查找匹配笔记名称的最新音频文件
    const audioFiles = this.app.vault.getFiles().filter((f) => {
      const inFolder = folder ? f.path.startsWith(folder + "/") || f.path === folder : true;
      const base = f.basename;
      return (
        inFolder &&
        (base === cleanBasename ||
          base === file.basename ||
          base.startsWith(cleanBasename) ||
          base.startsWith(file.basename)) &&
        (f.extension === "mp3" || f.extension === "m4a" || f.extension === "wav")
      );
    });

    if (audioFiles.length > 0) {
      audioFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);
      return audioFiles[0];
    }

    // 4. 全库搜索同名音频链接兜底
    for (const name of [cleanBasename, file.basename]) {
      for (const ext of extensions) {
        const dest = this.app.metadataCache.getFirstLinkpathDest(`${name}.${ext}`, file.path);
        if (dest instanceof TFile) return dest;
      }
    }

    return null;
  }

  async playAudioForNote(file: TFile) {
    const audioFile = this.findExistingAudioForNote(file);
    if (audioFile) {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view && view.file?.path === file.path) {
        await this.playAudioFileInView(view, file, audioFile);
        return;
      }
      new AudioResultModal(this.app, audioFile, file, this).open();
      return;
    }
    new Notice(`笔记「${file.basename}」尚未生成本地语音。可点击“听笔记”进行合成。`);
  }

  refreshAllInlineButtons() {
    this.renderAllButtons();
    // 异步延时重试兜底：应对 CodeMirror / Preview 异步构建 DOM 导致错过挂载
    window.setTimeout(() => this.renderAllButtons(), 120);
    window.setTimeout(() => this.renderAllButtons(), 400);
  }

  private renderAllButtons() {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      if (leaf.view instanceof MarkdownView) {
        this.mountPodcastCard(leaf.view);
        this.mountInlineTitleButton(leaf.view);
        this.mountHeaderActionButton(leaf.view);
      }
    }

    if (this.ribbonIconEl) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile && activeFile.extension === "md") {
        const isSynthesizing = this.activeSynthesizingPaths.has(activeFile.path);
        const audioFile = !isSynthesizing ? this.findExistingAudioForNote(activeFile) : null;
        if (isSynthesizing) {
          this.ribbonIconEl.setAttribute("aria-label", "听笔记：正在生成当前笔记语音...");
        } else if (audioFile) {
          this.ribbonIconEl.setAttribute("aria-label", `听笔记：播放音频 (${audioFile.name})`);
        } else {
          this.ribbonIconEl.setAttribute("aria-label", "听笔记：生成整篇笔记语音");
        }
      } else {
        this.ribbonIconEl.setAttribute("aria-label", "听笔记：播放或生成当前笔记语音");
      }
    }
  }

  mountPodcastCard(view: MarkdownView) {
    const file = view.file;
    if (!file) return;

    if (this.settings.showPodcastCard === false) {
      view.containerEl.querySelectorAll(".podvoice-podcast-card").forEach((el) => el.remove());
      return;
    }

    const isSynthesizing = this.activeSynthesizingPaths.has(file.path);
    const audioFile = !isSynthesizing ? this.findExistingAudioForNote(file) : null;

    // 仅在已有音频或正在生成时展示卡片，不打扰未生成语音的普通笔记
    if (!audioFile && !isSynthesizing) {
      view.containerEl.querySelectorAll(".podvoice-podcast-card").forEach((el) => el.remove());
      return;
    }

    // 优先挂载在 .inline-title 正下方
    const titleEl = view.containerEl.querySelector<HTMLElement>(".inline-title");
    const parentContainer =
      titleEl?.parentElement ||
      (view.containerEl.querySelector<HTMLElement>(".cm-sizer")) ||
      (view.containerEl.querySelector<HTMLElement>(".markdown-preview-sizer")) ||
      (view.containerEl.querySelector<HTMLElement>(".markdown-rendered"));

    if (!parentContainer) return;

    const targetAudioPath = audioFile?.path || "";
    const targetState = isSynthesizing ? "loading" : "ready";

    let card = parentContainer.querySelector<HTMLElement>(":scope > .podvoice-podcast-card");
    if (card) {
      const currentAudioPath = card.dataset.audioPath || "";
      const currentState = card.dataset.state || "";

      // 如果当前卡片已存在，且绑定的音频和生成状态完全一致：
      // 绝对不能调用 empty() 销毁！必须完整保留正在播放的 audio 元素与播放进度！
      if (currentAudioPath === targetAudioPath && currentState === targetState) {
        if (titleEl && titleEl.parentElement === parentContainer && titleEl.nextElementSibling !== card) {
          titleEl.insertAdjacentElement("afterend", card);
        }
        return;
      }
    }

    if (!card) {
      card = document.createElement("div");
      card.className = "podvoice-podcast-card";
      if (titleEl && titleEl.parentElement === parentContainer) {
        titleEl.insertAdjacentElement("afterend", card);
      } else {
        parentContainer.prepend(card);
      }
    }

    card.dataset.audioPath = targetAudioPath;
    card.dataset.state = targetState;
    card.dataset.filePath = file.path;

    card.empty();

    // 卡片内容主体
    if (isSynthesizing) {
      card.addClass("is-loading");
      const loadingWrap = card.createDiv({ cls: "podvoice-card-loading-wrap" });
      loadingWrap.createSpan({ cls: "podvoice-spinner-mini" });
      loadingWrap.createSpan({ text: "正在合成播客语音，稍候即可直接播放..." });
    } else if (audioFile) {
      card.removeClass("is-loading");

      // 播放器容器（单行流式布局：左侧播放器，右侧操作区）
      const playerWrap = card.createDiv({ cls: "podvoice-card-player-wrap" });
      const audioEl = playerWrap.createEl("audio", {
        attr: {
          controls: "true",
          preload: "metadata",
          src: this.app.vault.getResourcePath(audioFile),
        },
        cls: "podvoice-card-audio",
      });

      // 恢复记忆的播放进度（避免重新挂载或切换视图时从头播放）
      const savedTime = this.savedAudioPositions.get(audioFile.path);
      if (savedTime && savedTime > 0) {
        const restore = () => {
          if (!isNaN(audioEl.duration) && savedTime < audioEl.duration) {
            audioEl.currentTime = savedTime;
          }
        };
        audioEl.addEventListener("loadedmetadata", restore, { once: true });
        if (audioEl.readyState >= 1) {
          restore();
        }
      }

      // 持续记录播放进度
      audioEl.addEventListener("timeupdate", () => {
        if (!isNaN(audioEl.currentTime) && audioEl.currentTime > 0) {
          this.savedAudioPositions.set(audioFile.path, audioEl.currentTime);
        }
      });

      audioEl.addEventListener("play", () => {
        this.stopEarlyPlayback();
        if (this.activeFloatingPlayer && !this.activeFloatingPlayer.audio.paused) {
          this.activeFloatingPlayer.audio.pause();
        }
        view.containerEl.querySelectorAll(".podvoice-mowen-pill").forEach((pill) => pill.addClass("is-playing"));
      });
      audioEl.addEventListener("pause", () => {
        view.containerEl.querySelectorAll(".podvoice-mowen-pill").forEach((pill) => pill.removeClass("is-playing"));
      });
      audioEl.addEventListener("ended", () => {
        this.savedAudioPositions.set(audioFile.path, 0);
        view.containerEl.querySelectorAll(".podvoice-mowen-pill").forEach((pill) => pill.removeClass("is-playing"));
      });

      const actions = playerWrap.createDiv({ cls: "podvoice-card-actions" });

      // 重新生成语音按钮
      const regenBtn = actions.createEl("button", {
        cls: "clickable-icon podvoice-card-btn",
        attr: { "aria-label": "重新生成语音", title: "重新生成语音" },
      });
      setIcon(regenBtn, "rotate-cw");
      regenBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.synthesize(view, "note", view.editor, true).catch(error => new Notice(errorMessage(error)));
      });
    }
  }

  mountInlineTitleButton(view: MarkdownView) {
    const file = view.file;
    if (!file) return;

    if (this.settings.showTitleInlineButton === false) {
      view.containerEl.querySelectorAll(".podvoice-mowen-pill, .podvoice-inline-btn").forEach((el) => {
        if (el.parentElement?.closest(".view-header-actions")) return;
        el.remove();
      });
      return;
    }

    const pos = this.settings.titleButtonPosition || "right";
    const titleEls = view.containerEl.querySelectorAll(".inline-title");

    if (titleEls.length > 0) {
      titleEls.forEach((titleEl) => {
        let btn = titleEl.parentElement?.querySelector(`:scope > .podvoice-mowen-pill`) as HTMLButtonElement | null;
        if (!btn) {
          btn = document.createElement("button");
          btn.type = "button";
          btn.className = `podvoice-mowen-pill pos-${pos}`;
          btn.appendChild(sanitizeHTMLToDom(`<span class="podvoice-mowen-icon-wrap">${MOWEN_LISTEN_ICON_SVG}</span><span class="podvoice-mowen-text">听全文</span>`));

          btn.addEventListener("click", (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            void this.handleNoteAudioAction(view, evt).catch(error => new Notice(errorMessage(error)));
          });

          btn.addEventListener("contextmenu", (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            this.showPillContextMenu(evt, view, file);
          });

          if (pos === "bottom") {
            titleEl.insertAdjacentElement("afterend", btn);
          } else {
            // "right" 和 "top" 均插在 titleEl 前，由 CSS pos-right (float: right / align-self: flex-end) 或 pos-top 布局
            titleEl.insertAdjacentElement("beforebegin", btn);
          }
        } else {
          // 同步位置样式与实际 DOM 相对位置
          btn.removeClass("pos-right", "pos-top", "pos-bottom");
          btn.addClass(`pos-${pos}`);
          if (pos === "bottom" && titleEl.nextElementSibling !== btn) {
            titleEl.insertAdjacentElement("afterend", btn);
          } else if (pos !== "bottom" && titleEl.previousElementSibling !== btn) {
            titleEl.insertAdjacentElement("beforebegin", btn);
          }
        }

        this.updateButtonState(btn, view, file);
      });
    } else {
      // 容错兜底：未开启 Obsidian 内联标题时，挂载在正文容器顶部
      const contentContainer =
        (view.containerEl.querySelector<HTMLElement>(".cm-sizer")) ||
        (view.containerEl.querySelector<HTMLElement>(".markdown-preview-sizer")) ||
        (view.containerEl.querySelector<HTMLElement>(".markdown-rendered"));

      if (contentContainer) {
        let btn = contentContainer.querySelector<HTMLButtonElement>(":scope > .podvoice-mowen-pill");
        if (!btn) {
          btn = document.createElement("button");
          btn.type = "button";
          btn.className = `podvoice-mowen-pill pos-fallback pos-${pos}`;
          btn.appendChild(sanitizeHTMLToDom(`<span class="podvoice-mowen-icon-wrap">${MOWEN_LISTEN_ICON_SVG}</span><span class="podvoice-mowen-text">听全文</span>`));

          btn.addEventListener("click", (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            void this.handleNoteAudioAction(view, evt).catch(error => new Notice(errorMessage(error)));
          });

          btn.addEventListener("contextmenu", (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            this.showPillContextMenu(evt, view, file);
          });

          contentContainer.prepend(btn);
        }
        this.updateButtonState(btn, view, file);
      }
    }
  }

  mountHeaderActionButton(view: MarkdownView) {
    const file = view.file;
    if (!file) return;

    const headerActions = view.containerEl.querySelector(".view-header-actions");
    if (!headerActions) return;

    let headerBtn = headerActions.querySelector<HTMLElement>(".podvoice-header-btn");
    if (!headerBtn) {
      headerBtn = document.createElement("div");
      headerBtn.className = "clickable-icon view-action podvoice-header-btn";
      setIcon(headerBtn, "headphones");
      headerBtn.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        void this.handleNoteAudioAction(view, evt).catch(error => new Notice(errorMessage(error)));
      });
      headerActions.prepend(headerBtn);
    }

    const isSynthesizing = this.activeSynthesizingPaths.has(file.path);
    const audioFile = this.findExistingAudioForNote(file);

    if (isSynthesizing) {
      headerBtn.setAttribute("aria-label", "听笔记：正在生成语音...");
      headerBtn.addClass("is-loading");
    } else if (audioFile) {
      headerBtn.setAttribute("aria-label", `听笔记：播放音频 (${audioFile.name})`);
      headerBtn.removeClass("is-loading");
    } else {
      headerBtn.setAttribute("aria-label", "听笔记：生成整篇笔记语音");
      headerBtn.removeClass("is-loading");
    }
  }

  updateButtonState(btn: HTMLButtonElement, view: MarkdownView, file: TFile) {
    const isSynthesizing = this.activeSynthesizingPaths.has(file.path);
    const audioFile = !isSynthesizing ? this.findExistingAudioForNote(file) : null;
    const textEl = btn.querySelector(".podvoice-mowen-text");
    const pos = this.settings.titleButtonPosition || "right";

    btn.removeClass("is-generating", "is-has-audio", "is-outdated", "is-ready", "is-playing");
    btn.addClass(`pos-${pos}`);

    if (isSynthesizing) {
      btn.addClass("is-generating");
      if (textEl) textEl.textContent = this.earlyPlayer?.matches(file) ? "边听边生成" : "生成中...";
      btn.setAttribute("aria-label", "听全文：正在后台生成语音...");
      btn.title = "听全文：正在后台生成语音，请稍候...";
    } else if (audioFile) {
      btn.addClass("is-has-audio");
      if (textEl) textEl.textContent = "听全文";

      // 联动播放状态
      const audioEl = view.containerEl.querySelector<HTMLAudioElement>(".podvoice-card-audio");
      if (audioEl && !audioEl.paused) {
        btn.addClass("is-playing");
      }

      // 检测文章是否有改动
      this.isNoteModifiedSinceAudio(file, audioFile).then((modified) => {
        if (!btn.isConnected) return;
        if (modified) {
          btn.addClass("is-outdated");
          btn.setAttribute("aria-label", `听全文：文章自生成后有更新，点击可播放或重新生成 (${audioFile.name})`);
          btn.title = `听全文：文章自上次生成后有更新，点击可选择播放或重新生成 (${audioFile.name})`;
        } else {
          btn.removeClass("is-outdated");
          btn.setAttribute("aria-label", `听全文：已生成语音，点击播放 (${audioFile.name})`);
          btn.title = `听全文：已生成语音，点击播放 (${audioFile.name})`;
        }
      }).catch(error => console.warn("读取笔记音频状态失败", error));
    } else {
      btn.addClass("is-ready");
      if (textEl) textEl.textContent = "听全文";
      btn.setAttribute("aria-label", "听全文：点击后台生成整篇笔记语音");
      btn.title = "听全文：点击后台生成整篇笔记语音";
    }
  }

  async handleNoteAudioAction(view: MarkdownView, evt?: MouseEvent) {
    const file = view.file;
    if (!file) {
      new Notice("请先打开一篇笔记。");
      return;
    }

    if (this.earlyPlayer?.matches(file)) {
      this.earlyPlayer.toggle();
      return;
    }

    if (this.activeSynthesizingPaths.has(file.path)) {
      new Notice("🎧 正在为当前笔记后台生成语音，请稍候...");
      return;
    }

    const existingAudio = this.findExistingAudioForNote(file);
    if (!existingAudio) {
      // 1. 尚未生成语音：点击直接在后台静默生成，无需弹出模态窗
      await this.synthesize(view, "note", view.editor, true);
      return;
    }

    // 2. 已生成语音：检查文章自生成之后是否修改过
    const modified = await this.isNoteModifiedSinceAudio(file, existingAudio);
    if (!modified) {
      // 文章未修改：直接播放现有音频，避免重复生成
      new Notice(`▶️ 全文语音已就绪，正在播放「${file.basename}」`);
      void this.playAudioFileInView(view, file, existingAudio).catch(error => new Notice(errorMessage(error)));
      return;
    }

    // 3. 文章已修改过：弹出菜单供用户选择
    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle("▶️ 播放现存音频 (文章有更新)")
        .setIcon("play")
        .onClick(() => {
          void this.playAudioFileInView(view, file, existingAudio).catch(error => new Notice(errorMessage(error)));
        });
    });
    menu.addItem((item) => {
      item
        .setTitle("🔄 文章已修改，重新生成全文语音")
        .setIcon("rotate-cw")
        .onClick(async () => {
          await this.synthesize(view, "note", view.editor, true);
        });
    });

    if (evt) {
      menu.showAtMouseEvent(evt);
    } else {
      const btn = view.containerEl.querySelector<HTMLElement>(".podvoice-mowen-pill");
      if (btn) {
        const rect = btn.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
      }
    }
  }

  private async playAudioFileInView(view: MarkdownView, file: TFile, audioFile: TFile) {
    this.earlyPlayer?.destroy();
    if (this.settings.enableFloatingPlayer !== false) {
      await this.activateFloatingPlayer(view, file, audioFile);
      this.refreshAllInlineButtonsDebounced(60);
      return;
    }

    let audioEl = view.containerEl.querySelector<HTMLAudioElement>(".podvoice-card-audio");
    if (!audioEl && this.settings.showPodcastCard !== false) {
      this.mountPodcastCard(view);
      audioEl = view.containerEl.querySelector<HTMLAudioElement>(".podvoice-card-audio");
    }

    if (audioEl) {
      if (audioEl.paused) {
        audioEl.play().catch((err) => {
          console.warn("Card audio playback failed, opening modal player:", err);
          new AudioResultModal(this.app, audioFile, file, this).open();
        });
      } else {
        audioEl.pause();
        new Notice("⏸️ 已暂停播放");
      }
      audioEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
      view.containerEl.querySelectorAll(".podvoice-mowen-pill").forEach((pill) => {
        if (audioEl && !audioEl.paused) {
          pill.addClass("is-playing");
        } else {
          pill.removeClass("is-playing");
        }
      });
      return;
    }

    new AudioResultModal(this.app, audioFile, file, this).open();
  }

  private getVoiceMenuOptions(): VoiceMenuOption[] {
    const s = this.settings;
    const has = (value: string) => Boolean(value?.trim());
    const options = (voices: readonly { id: string; name: string }[], key: VoiceSettingKey,
      missing: string, customReady = true): VoiceMenuOption[] => voices.map((voice) => ({
        ...voice, key,
        unavailable: missing || (voice.id === "custom" && !customReady ? "未配置自定义音色" : ""),
      }));

    if (s.provider === "gptsovits") {
      const customReady = has(s.gptsovitsCustomRefAudio) && has(s.gptsovitsCustomPromptText);
      const voices = GPTSOVITS_VOICES.filter((voice) => voice.id !== "custom" || customReady || s.gptsovitsVoicePreset === "custom");
      return options(voices, "gptsovitsVoicePreset",
        has(s.gptsovitsEndpoint) ? "" : "未配置服务地址",
        customReady);
    }
    if (s.provider === "volcengine") {
      const voices = VOLCENGINE_VOICES.map((voice) => ({ ...voice }));
      if (has(s.volcengineVoiceType) && !voices.some((voice) => voice.id === s.volcengineVoiceType)) {
        voices.push({ id: s.volcengineVoiceType, name: s.volcengineVoiceType });
      }
      return options(voices, "volcengineVoiceType",
        has(s.volcengineAppId) && has(s.volcengineAccessToken) ? "" : "未配置服务凭证",
        has(s.volcengineCustomVoiceType));
    }
    if (s.provider === "minimax") {
      return options([{ id: s.minimaxVoiceId, name: s.minimaxVoiceId || "MiniMax 音色" }], "minimaxVoiceId",
        !has(s.minimaxApiKey) ? "未配置服务凭证" : !has(s.minimaxVoiceId) ? "未配置音色" : "");
    }
    if (s.provider === "replicate" && (s.replicateModel || REPLICATE_MINIMAX_MODEL) === REPLICATE_MINIMAX_MODEL) {
      return options([
        ...REPLICATE_MINIMAX_VOICES.map((id) => ({ id, name: id })),
        { id: "custom", name: "自定义音色" },
      ], "replicateVoiceId", has(s.replicateApiToken) ? "" : "未配置服务凭证", has(s.replicateCustomVoiceId));
    }
    // Custom HTTP and advanced Replicate models define voices in their request templates.
    return [];
  }

  private isVoiceSwitchBusy(): boolean {
    return this.savingVoiceSelection;
  }

  private async selectMenuVoice(provider: ProviderId, key: VoiceSettingKey, id: string) {
    if (this.isVoiceSwitchBusy()) {
      new Notice("正在保存音色，请稍后再切换。");
      return;
    }
    const option = this.getVoiceMenuOptions().find((voice) => voice.key === key && voice.id === id);
    if (this.settings.provider !== provider || !option || option.unavailable) {
      new Notice("音色配置已变化，请重新打开菜单或前往插件设置。");
      return;
    }
    if (this.settings[key] === id) return;
    const previous = this.settings[key];
    this.savingVoiceSelection = true;
    // Each option comes from the matching provider's settings dropdown.
    Object.assign(this.settings, { [key]: id });
    try {
      await this.saveSettings();
      new Notice(`已切换为「${option.name}」。新生成语音将使用此音色；已有录音需重新生成。`, 6000);
    } catch (error) {
      Object.assign(this.settings, { [key]: previous });
      new Notice(`音色保存失败：${errorMessage(error)}`);
    } finally {
      this.savingVoiceSelection = false;
      this.wakeGenerationWaiters();
    }
  }

  private openVoiceSettings() {
    // Obsidian's settings navigation is not exposed in the public App typings.
    const setting = (this.app as App & { setting?: { open(): void; openTabById(id: string): void } }).setting;
    if (setting?.open && setting?.openTabById) {
      setting.open();
      setting.openTabById(this.manifest.id);
    } else {
      new Notice(`请打开 Obsidian 设置 → ${this.manifest.name}，配置语音服务和音色。`);
    }
  }

  private showPillContextMenu(evt: MouseEvent, view: MarkdownView, file: TFile) {
    const menu = new Menu();
    const audioFile = this.findExistingAudioForNote(file);
    const provider = this.settings.provider;
    const busy = this.isVoiceSwitchBusy();
    const voices = this.getVoiceMenuOptions();
    menu.addItem((item) => item.setTitle(busy ? "正在保存音色，请稍候" : this.batchPaused ? "批量已暂停，可切换音色并手动生成" : "选择音色（仅影响新任务，生成中音色不变）").setIsLabel(true));
    for (const voice of voices) {
      menu.addItem((item) => item
        .setTitle(voice.unavailable ? `${voice.name} · ${voice.unavailable}` : voice.name)
        .setChecked(this.settings[voice.key] === voice.id)
        .setDisabled(busy || Boolean(voice.unavailable))
        .onClick(() => this.selectMenuVoice(provider, voice.key, voice.id)));
    }
    if (!voices.length) {
      menu.addItem((item) => item.setTitle("此服务的音色需在插件设置中配置").setDisabled(true));
    }
    menu.addItem((item) => item.setTitle("配置音色…").setIcon("settings").onClick(() => this.openVoiceSettings()));
    if (this.isBatchSyncing || this.batchPauseState) {
      menu.addItem(item => item.setTitle(this.batchPauseState ? "恢复批量任务（等待手动任务结束）" : "暂停批量任务（当前小段完成后）")
        .onClick(() => this.batchPauseState ? this.resumeBatchGeneration() : this.pauseBatchGeneration()));
    }
    menu.addSeparator();

    if (audioFile) {
      menu.addItem((item) => {
        item
          .setTitle("▶️ 播放当前音频")
          .setIcon("play")
          .onClick(() => {
            void this.playAudioFileInView(view, file, audioFile).catch(error => new Notice(errorMessage(error)));
          });
      });
    }

    menu.addItem((item) => {
      item
        .setTitle("🔄 重新生成全文语音 (后台静默)")
        .setIcon("rotate-cw")
        .setDisabled(busy || this.activeSynthesizingPaths.has(file.path))
        .onClick(async () => {
          if (this.isVoiceSwitchBusy() || this.activeSynthesizingPaths.has(file.path)) {
            new Notice("当前笔记正在生成或音色正在保存，请稍候。");
            return;
          }
          if (view.file?.path !== file.path) {
            new Notice("当前笔记已切换，请重新打开菜单。");
            return;
          }
          await this.synthesize(view, "note", view.editor, true);
        });
    });

    if (audioFile) {
      menu.addItem((item) => {
        item
          .setTitle("🪟 打开独立播放弹窗")
          .setIcon("expand")
          .onClick(() => {
            new AudioResultModal(this.app, audioFile, file, this).open();
          });
      });

      menu.addItem((item) => {
        item
          .setTitle("📋 复制音频链接")
          .setIcon("copy")
          .onClick(async () => {
            await navigator.clipboard.writeText(`[[${audioFile.path}]]`);
            new Notice("已复制音频链接");
          });
      });
    }

    menu.showAtMouseEvent(evt);
  }

  async getSpeechTiming(audioFile: TFile): Promise<SpeechTiming> {
    const existing = this.speechTimingJobs.get(audioFile.path);
    if (existing) return existing;
    const job = this.speechTimingQueue.then(() => this.loadOrCreateSpeechTiming(audioFile));
    this.speechTimingJobs.set(audioFile.path, job);
    this.speechTimingQueue = job.then(() => {}, () => {});
    try { return await job; }
    finally { this.speechTimingJobs.delete(audioFile.path); }
  }

  private async loadOrCreateSpeechTiming(audioFile: TFile): Promise<SpeechTiming> {
    if (this.unloading) throw new Error("插件已关闭。");
    const digest = await audioDigest(await this.app.vault.readBinary(audioFile));
    const cachePath = audioFile.path + ".podvoice-timing.json";
    try {
      const cached: unknown = JSON.parse(await this.app.vault.adapter.read(cachePath));
      if (isSpeechTiming(cached, digest)) return cached;
    } catch { /* Missing, interrupted or obsolete caches are regenerated. */ }
    const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & { getBasePath?: () => string };
    if (typeof adapter.getBasePath !== "function") throw new Error("此设备只能使用已同步的语音时间戳，请先在桌面端打开音频完成对齐。");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load optional desktop APIs only when this feature runs.
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load optional desktop APIs only when this feature runs.
    const path = require("path") as typeof import("path");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load optional desktop APIs only when this feature runs.
    const home = (require("os") as typeof import("os")).homedir();
    const candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
    for (const base of [path.join(home, ".local/share/fnm/node-versions"), path.join(home, ".nvm/versions/node")]) {
      if (fs.existsSync(base)) for (const name of fs.readdirSync(base).sort().reverse()) {
        candidates.push(path.join(base, name, "installation/bin/node"), path.join(base, name, "bin/node"));
      }
    }
    for (const bin of (process.env.PATH || "").split(path.delimiter)) if (bin) candidates.push(path.join(bin, process.platform === "win32" ? "node.exe" : "node"));
    const node = candidates.find(candidate => fs.existsSync(candidate));
    const root = adapter.getBasePath();
    const pluginDir = path.join(root, this.manifest.dir || `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    if (!node) throw new Error("缺少 Node.js，请先安装离线对齐运行环境。");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load optional desktop APIs only when this feature runs.
    const { execFile } = require("child_process") as typeof import("child_process");
    if (this.unloading) throw new Error("插件已关闭。");
    const timing = await new Promise<SpeechTiming>((resolve, reject) => {
      const child = execFile(node, ["-", path.join(root, audioFile.path)],
        { cwd: pluginDir, timeout: 20 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
          this.speechTimingProcesses.delete(child);
          if (error) { reject(new Error(stderr.trim().split("\n").slice(-1)[0] || "离线语音对齐失败。")); return; }
          try {
            const parsed: unknown = JSON.parse(stdout);
            if (!isSpeechTiming(parsed, digest)) throw new Error("语音时间戳无效或音频已更新。");
            resolve(parsed);
          } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
        });
      this.speechTimingProcesses.add(child);
      // Send only the worker bundled in this release, never downloaded executable code.
      child.stdin?.on("error", () => { /* execFile reports process failures above. */ });
      child.stdin?.end(PODVOICE_SPEECH_TIMING_SOURCE);
    });
    if (this.unloading || digest !== await audioDigest(await this.app.vault.readBinary(audioFile))) {
      throw new Error("分析期间音频已更新，请重新打开播放器。");
    }
    await this.app.vault.adapter.write(cachePath, JSON.stringify(timing));
    return timing;
  }

  private async saveAudioFile(sourceFile: TFile, audio: AudioResult, settings = { ...this.settings }, task?: GenerationTask): Promise<TFile> {
    const save = this.audioSaveQueue.then(() => this.saveAudioFileNow(sourceFile, audio, settings, task));
    this.audioSaveQueue = save.then(() => {}, () => {});
    return save;
  }

  private async saveAudioFileNow(sourceFile: TFile, audio: AudioResult, settings: NoteTtsSettings, task?: GenerationTask): Promise<TFile> {
    if (this.unloading) throw new Error("插件已卸载，停止保存音频。");
    if (task?.kind === "batch" && this.manualCompletedPaths.has(sourceFile.path)) throw new BatchSupersededError();
    if (audio.vaultPath) {
      const synced = await this.waitForVaultFile(audio.vaultPath, undefined, 20000);
      if (synced) {
        return synced;
      }
      throw new PendingTaskError(`语音已保存在 iCloud：${audio.vaultPath}。手机 iCloud 还没同步到，稍后会出现在 TTS Audio 文件夹。`);
    }

    if (!audio.data) {
      throw new Error("语音结果没有音频数据。");
    }

    const folder = normalizeFolder(settings.outputFolder);
    await ensureFolder(this.app, folder);

    const basename = sourceFile.basename.replace(/[/:*?"<>|#^[\]]/g, "-").slice(0, 80);
    const ext = audio.extension || "mp3";

    let targetPath = "";
    let audioFile: TFile;

    if (settings.audioNamingMode === "clean" || settings.keepOnlyLatestAudio) {
      targetPath = `${folder}/${basename}.${ext}`;
      const existing = this.app.vault.getAbstractFileByPath(targetPath);
      if (existing instanceof TFile) {
        await this.app.vault.modifyBinary(existing, audio.data);
        audioFile = existing;
      } else {
        audioFile = await this.app.vault.createBinary(targetPath, audio.data);
      }

      if (settings.keepOnlyLatestAudio) {
        const legacyOldFiles = this.app.vault.getFiles().filter((f) => {
          return (
            f.path.startsWith(folder + "/") &&
            f.path !== targetPath &&
            f.basename.startsWith(basename + "-20") &&
            (f.extension === "mp3" || f.extension === "m4a" || f.extension === "wav")
          );
        });
        for (const oldFile of legacyOldFiles) {
          try {
            await this.app.vault.delete(oldFile);
            await this.removeSpeechTimingCache(oldFile.path);
          } catch (e) {
            console.warn("清理旧时间戳音频失败:", oldFile.path, e);
          }
        }
      }
    } else {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      targetPath = `${folder}/${basename}-${timestamp}.${ext}`;
      audioFile = await this.app.vault.createBinary(targetPath, audio.data);
    }

    if (settings.associateNoteFrontmatter && sourceFile.extension === "md") {
      try {
        await this.app.fileManager.processFrontMatter(sourceFile, (fm) => {
          const key = settings.frontmatterKey?.trim() || "audio";
          (fm as Record<string, unknown>)[key] = `[[${targetPath}]]`;
        });
      } catch (err) {
        console.warn("写入 Frontmatter 失败:", err);
      }
    }

    if (settings.autoEmbedInNote !== "none" && sourceFile.extension === "md") {
      try {
        const content = await this.app.vault.read(sourceFile);
        const embedTag = `![[${targetPath}]]\n\n`;
        if (!content.includes(`![[${targetPath}]]`)) {
          if (settings.autoEmbedInNote === "top") {
            const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/);
            if (fmMatch) {
              const prefixLen = fmMatch[0].length;
              const newContent = content.slice(0, prefixLen) + embedTag + content.slice(prefixLen);
              await this.app.vault.modify(sourceFile, newContent);
            } else {
              await this.app.vault.modify(sourceFile, embedTag + content);
            }
          } else if (settings.autoEmbedInNote === "bottom") {
            await this.app.vault.modify(sourceFile, content + "\n\n" + embedTag);
          }
        }
      } catch (err) {
        console.warn("正文插入嵌入标签失败:", err);
      }
    }

    return audioFile;
  }

  async activateFloatingPlayer(view: MarkdownView, file: TFile, audioFile: TFile) {
    this.earlyPlayer?.destroy();
    if (this.activeFloatingPlayer && this.activeFloatingPlayer.file.path === file.path) {
      this.activeFloatingPlayer.togglePlayPause();
      return;
    }

    if (this.activeFloatingPlayer) {
      this.activeFloatingPlayer.destroy();
      this.activeFloatingPlayer = null;
    }

    const player = new NoteFloatingPlayer(this.app, this, view, file, audioFile);
    await player.init();
    this.activeFloatingPlayer = player;
  }

  stopEarlyPlayback() {
    this.earlyPlayer?.destroy();
  }

  private async waitForVaultFile(path: string, status?: TtsStatusModal, timeoutMs = 20000): Promise<TFile | null> {
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        return file;
      }
      status?.setStatus("语音已保存到 iCloud，等待手机同步文件...");
      await sleep(1000);
    }
    return null;
  }
}

// Schedule decoded, unmodified WAVs on a single clock. No re-synthesis or filtering.
// The 0.5 s boundaries match concatenateWavs; a slow producer waits at the buffer end.
class BufferedPcmPlayback {
  private clips: { buffer: AudioBuffer; start: number; end: number }[] = [];
  private sources = new Set<AudioBufferSourceNode>();
  private offset = 0;
  private clock = 0;
  private running = false;
  private wanted = false;
  private revision = 0;
  private closed = false;
  private finished = false;
  duration = 0;

  constructor(private context: AudioContext) {}
  get isPlaying() { return this.wanted; }
  get position() {
    return Math.min(this.duration, this.offset + (this.running ? Math.max(0, this.context.currentTime - this.clock) : 0));
  }

  append(buffer: AudioBuffer) {
    if (this.closed) return;
    const previousEnd = this.duration;
    const position = this.position;
    const start = this.clips.length ? previousEnd + 0.5 : 0;
    const clip = { buffer, start, end: start + buffer.duration };
    this.clips.push(clip);
    this.duration = clip.end;
    if (this.running) {
      if (position >= previousEnd) {
        this.offset = previousEnd;
        this.clock = this.context.currentTime;
      }
      this.schedule(clip);
    }
  }

  async play() {
    if (this.closed || this.wanted) return;
    if (this.finished && this.position >= this.duration) this.offset = 0;
    this.wanted = true;
    const revision = ++this.revision;
    try {
      await this.context.resume();
      if (this.closed || !this.wanted || revision !== this.revision) return;
      this.clock = this.context.currentTime;
      this.running = true;
      for (const clip of this.clips) this.schedule(clip);
    } catch (error) {
      if (revision === this.revision) this.pause();
      throw error;
    }
  }

  pause() {
    this.offset = this.position;
    this.running = this.wanted = false;
    this.revision++;
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
  }

  seek(seconds: number) {
    const resume = this.wanted;
    this.pause();
    this.offset = Math.max(0, Math.min(this.duration, seconds));
    if (resume) void this.play().catch(() => {});
  }

  finish() {
    this.finished = true;
    if (this.position >= this.duration) this.pause();
  }

  private schedule(clip: { buffer: AudioBuffer; start: number; end: number }) {
    const now = this.context.currentTime;
    const position = Math.min(this.duration, this.offset + Math.max(0, now - this.clock));
    if (clip.end <= position) return;
    const source = this.context.createBufferSource();
    source.buffer = clip.buffer;
    source.connect(this.context.destination);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      if (this.finished && this.position >= this.duration) this.pause();
    };
    source.start(Math.max(now, this.clock + clip.start - this.offset),
      Math.max(0, position - clip.start));
  }

  destroy() {
    if (this.closed) return;
    this.pause();
    this.closed = true;
    this.clips = [];
    void this.context.close().catch(() => {});
  }
}

class ProgressiveAudioPlayer {
  private context = new AudioContext();
  private queue = new BufferedPcmPlayback(this.context);
  private floating: NoteFloatingPlayer | null = null;
  private ready: Promise<void>;
  private decoding: Promise<void> = Promise.resolve();
  private closed = false;
  private received = 0;
  private failed = false;
  private decodeFailed = false;
  private saved?: TFile;

  constructor(private plugin: NoteTtsPlugin, readonly file: TFile, private count: number) {
    const view = plugin.app.workspace.getLeavesOfType("markdown")
      .map(leaf => leaf.view).find(view => view instanceof MarkdownView && view.file?.path === file.path) as MarkdownView | undefined;
    if (!view) { this.queue.destroy(); throw new Error("请在笔记页面中使用边听边生成。"); }
    this.floating = new NoteFloatingPlayer(plugin.app, plugin, view, file, file, this);
    plugin.activeFloatingPlayer = this.floating;
    this.ready = this.floating.init().catch(error => { console.warn("播放器初始化失败:", error); this.destroy(); });
  }

  get position() { return this.queue.position; }
  get duration() { return this.queue.duration; }
  get isPlaying() { return this.queue.isPlaying; }
  get status() {
    return this.failed ? "生成失败，可播放已生成部分"
      : this.decodeFailed ? "提前播放不可用，等待完整音频"
      : this.isPlaying && this.position >= this.duration ? `等待下一段 · 已生成 ${this.received}/${this.count} 段`
      : `边听边生成 · 已生成 ${this.received}/${this.count} 段`;
  }
  seek(seconds: number) { this.queue.seek(seconds); }
  append(audio: AudioResult, index: number) {
    this.decoding = this.decoding.then(async () => {
      if (this.closed || this.decodeFailed || !audio.data) return;
      const decoded = await this.context.decodeAudioData(audio.data.slice(0));
      if (this.closed) return;
      this.queue.append(decoded);
      this.received = index + 1;
      if (index === 0) void this.queue.play().catch(() => {});
    }).catch(error => { if (!this.closed) { this.decodeFailed = true; this.queue.pause(); console.warn("提前播放解码失败:", error); } });
  }
  complete(saved: TFile) {
    void Promise.all([this.decoding, this.ready]).then(() => {
      if (this.closed) return;
      this.saved = saved;
      const position = this.position, playing = this.isPlaying;
      this.queue.destroy();
      const floating = this.floating;
      this.floating = null;
      floating?.completeProgressive(saved, position, playing);
    });
  }
  fail() { this.failed = true; void this.decoding.then(() => { if (!this.closed) this.queue.finish(); }); }
  toggle() {
    if (this.closed) return;
    if (this.isPlaying) this.queue.pause();
    else void this.queue.play().catch(() => new Notice("请再次点击播放，允许音频播放。"));
  }
  matches(file: TFile) { return !this.closed && !this.saved && this.file.path === file.path; }
  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.queue.destroy();
    const floating = this.floating;
    this.floating = null;
    floating?.destroy();
  }
}

interface SpeechToken { text: string; start: number; end: number; }
interface SpeechTiming {
  version: 1;
  engine: "sensevoice";
  audioSha256: string;
  duration: number;
  tokens: SpeechToken[];
}

function isSpeechTiming(input: unknown, audioSha256: string): input is SpeechTiming {
  if (!input || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  const duration = value.duration;
  if (value.version !== 1 || value.engine !== "sensevoice" ||
    value.audioSha256 !== audioSha256 || !/^[a-f0-9]{64}$/.test(audioSha256) ||
    typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 || duration > 7200 ||
    !Array.isArray(value.tokens) || !value.tokens.length || value.tokens.length > 200000) return false;
  let previous = -1;
  return value.tokens.every((input: unknown) => {
    if (!input || typeof input !== "object") return false;
    const token = input as Record<string, unknown>;
    if (typeof token.text !== "string" || !token.text.length || token.text.length > 200 ||
      typeof token.start !== "number" || typeof token.end !== "number" ||
      !Number.isFinite(token.start) || !Number.isFinite(token.end) || token.start < 0 ||
      token.start < previous || token.end <= token.start || token.end > duration + .001) return false;
    previous = token.start;
    return true;
  });
}

async function audioDigest(data: ArrayBuffer): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const hash = await globalThis.crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load optional desktop APIs only when this feature runs.
  return (require("crypto") as typeof import("crypto")).createHash("sha256").update(new Uint8Array(data)).digest("hex");
}

function normalizeSpeechText(text: string): string {
  const digits = "零一二三四五六七八九";
  const numberWord = (value: number): string => {
    if (value < 10) return digits[value];
    if (value < 100) return (value < 20 ? "" : digits[Math.floor(value / 10)]) + "十" + (value % 10 ? digits[value % 10] : "");
    const unit = value < 1000 ? 100 : 1000, rest = value % unit;
    return digits[Math.floor(value / unit)] + (unit === 100 ? "百" : "千") +
      (rest ? (rest < unit / 10 ? "零" : "") + (rest >= 10 && rest < 20 ? "一" : "") + numberWord(rest) : "");
  };
  return text.normalize("NFKC").toLowerCase()
    .replace(/\d{4}(?=\s*年)/g, year => Array.from(year, digit => digits[Number(digit)]).join(""))
    .replace(/(?<![a-z\d.])\d{1,4}(?![a-z\d.]|\s*\.\s*\d)/g, number => numberWord(Number(number)))
    .replace(/[^\p{L}\p{N}]/gu, "");
}

// Monotonic text matching only copies timestamps from recognized audio tokens.
// It never interpolates a missing sentence from character counts or duration.
function alignSentencesToSpeech(sentences: NoteSentence[], tokens: SpeechToken[], spokenText: (s: NoteSentence) => string): number {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Defer the bundled diff helper until alignment runs.
  const { diffChars } = require("diff") as typeof import("diff");
  const texts = sentences.map(s => normalizeSpeechText(spokenText(s)));
  const source = texts.join("");
  const recognized: string[] = [];
  const tokenIndices: number[] = [];
  tokens.forEach((token, index) => {
    for (const ch of normalizeSpeechText(token.text)) { recognized.push(ch); tokenIndices.push(index); }
  });
  if (!source || !recognized.length || source.length > 100000 || recognized.length > 100000) return 0;
  const changes = diffChars(source, recognized.join(""), { timeout: 400, maxEditLength: 6000 });
  if (!changes) return 0;
  const mapping = new Map<number, number>();
  let sourceIndex = 0, targetIndex = 0;
  for (const change of changes) {
    const count = Array.from(change.value).length;
    if (change.added) targetIndex += count;
    else if (change.removed) sourceIndex += count;
    else for (let i = 0; i < count; i++) mapping.set(sourceIndex++, targetIndex++);
  }
  let offset = 0, matched = 0, previousEnd = 0;
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i], length = Array.from(texts[i]).length;
    const indices: number[] = [];
    for (let j = 0; j < length; j++) { const target = mapping.get(offset + j); if (target !== undefined) indices.push(target); }
    const first = mapping.get(offset), second = mapping.get(offset + 1);
    const last = indices[indices.length - 1];
    // A wrong final ASR character must not discard a well-anchored onset.
    // Use the last matched token's end; never infer the missing tail's time.
    const tailMatched = [1, 2, 3].some(back => back <= length && mapping.has(offset + length - back));
    const reliable = length >= 2 && indices.length / length >= .8 && first !== undefined &&
      second === first + 1 && tailMatched && last !== undefined && last - first + 1 <= length * 1.35 &&
      (length > 5 || indices.length === length);
    sentence.startTime = -1; sentence.endTime = -1; sentence.timingSource = "unmatched";
    if (reliable) {
      const begin = tokens[tokenIndices[first]], end = tokens[tokenIndices[last]];
      if (begin.start >= previousEnd && end.end > begin.start) {
        sentence.startTime = begin.start; sentence.endTime = end.end;
        sentence.timingSource = "speech"; previousEnd = end.end; matched++;
      }
    }
    offset += length;
  }
  return matched;
}

interface NoteSentence {
  id: number;
  text: string;           // 纯净朗读文本片段
  raw: string;            // 原文对应片段（用于在 DOM 中检索比对）
  lineIndex: number;      // 在 Markdown 原文中的估计行号
  startTime: number;      // 句子开始时间（秒）
  endTime: number;        // 句子结束时间（秒）
  weight: number;         // 语速发音与停顿加权
  timingSource?: "speech" | "unmatched";
}

class NoteSentenceAligner {
  static parseSentences(
    markdownContent: string,
    noteTitle?: string,
    includeTitle = true,
    skipLinePatterns = ""
  ): NoteSentence[] {
    const sentences: NoteSentence[] = [];
    let idCounter = 0;

    const lines = markdownContent.split("\n");

    const compiledSkipPatterns = (skipLinePatterns || "")
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        try {
          return new RegExp(p, "iu");
        } catch {
          return null;
        }
      })
      .filter((p): p is RegExp => Boolean(p));

    const trimmedTitle = (noteTitle || "").trim();

    const normalizeForCompare = (str: string) =>
      str
        .replace(/^#{1,6}\s+/, "")
        .replace(/^\s*[-*+]\s+/, "")
        .replace(/^\s*\d+\.\s+/, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/[*_~`]/g, "")
        .replace(/[。！？，；：、.!?,;:"'“”‘’（）()[\]【】《》〈〉\s]/g, "")
        .toLowerCase();

    // 检查正文开头第一行有效内容是否已包含标题（与 cleanTextForTts 保持完全一致的防重复逻辑）
    let alreadyHasTitle = false;
    if (trimmedTitle) {
      let inFm = false;
      let inCb = false;
      for (const line of lines) {
        const t = line.trim();
        if (t === "---") {
          inFm = !inFm;
          continue;
        }
        if (inFm) continue;
        if (t.startsWith("```")) {
          inCb = !inCb;
          continue;
        }
        if (inCb || !t) continue;
        if (/^!\[.*?\]\(.*?\)/.test(t) || /^!\[\[.*?\]\]/.test(t)) continue;
        if (t.startsWith("<!--") && t.endsWith("-->")) continue;
        if (compiledSkipPatterns.some((p) => p.test(t))) continue;

        const normLine = normalizeForCompare(t);
        const normTitle = normalizeForCompare(trimmedTitle);
        if (
          normTitle.length > 0 &&
          (normLine === normTitle ||
            (normLine.startsWith(normTitle) && normLine.length <= normTitle.length + 10))
        ) {
          alreadyHasTitle = true;
        }
        break;
      }
    }

    // 1. 如果需要包含标题作为首句，且正文开头并不包含标题（避免重复）
    if (includeTitle && trimmedTitle && !alreadyHasTitle) {
      const cleanTitle = trimmedTitle.replace(/^#{1,6}\s+/, "");
      sentences.push({
        id: idCounter++,
        text: cleanTitle,
        raw: cleanTitle,
        lineIndex: 0,
        startTime: 0,
        endTime: 0,
        weight: Math.max(cleanTitle.length, 3) + 2.0,
      });
    }

    // 2. 逐行扫描正文，提取朗读句子
    let inFrontmatter = false;
    let inCodeBlock = false;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const trimmed = line.trim();

      if (lineIdx === 0 && trimmed === "---") {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter) {
        if (trimmed === "---") inFrontmatter = false;
        continue;
      }

      if (trimmed.startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock || !trimmed) continue;

      if (/^!\[.*?\]\(.*?\)/.test(trimmed) || /^!\[\[.*?\]\]/.test(trimmed)) continue;
      if (trimmed.startsWith("<!--") && trimmed.endsWith("-->")) continue;
      if (compiledSkipPatterns.some((pattern) => pattern.test(trimmed))) continue;

      const cleanLine = trimmed
        .replace(/^#{1,6}\s+/, "")
        .replace(/^\s*[-*+]\s+/, "")
        .replace(/^\s*\d+\.\s+/, "")
        .replace(/^\s*>+\s*/, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m: string, p1: string, p2: string) => p2 || p1)
        .trim();

      if (!cleanLine || !/[\p{L}\p{N}]/u.test(cleanLine)) continue;

      // 按中文/英文句末标点细分句子
      const parts = cleanLine.split(/([。！？!?；;]+)/);
      for (let i = 0; i < parts.length; i += 2) {
        const seg = (parts[i] || "").trim();
        const punct = parts[i + 1] || "";
        const fullSeg = (seg + punct).trim();
        if (!fullSeg || !/[\p{L}\p{N}]/u.test(fullSeg)) continue;

        let weight = fullSeg.length * 1.0;
        const commaCount = (fullSeg.match(/[，,、]/g) || []).length;
        weight += commaCount * 1.0; // 真实逗号停顿校准
        if (/[。！？!?]$/.test(fullSeg)) {
          weight += 2.0; // 真实句末停顿约 0.45s~0.5s，消除原 3.5 导致的累积时间膨胀与滞后
        } else if (/[；;]$/.test(fullSeg)) {
          weight += 1.5;
        } else {
          weight += 1.0;
        }

        sentences.push({
          id: idCounter++,
          text: fullSeg,
          raw: seg,
          lineIndex: lineIdx,
          startTime: 0,
          endTime: 0,
          weight: Math.max(weight, 1.5),
        });
      }
    }

    return sentences;
  }

  static alignTimestamps(sentences: NoteSentence[], totalDuration: number): void {
    if (!sentences.length || totalDuration <= 0) return;

    const totalWeight = sentences.reduce((sum, s) => sum + s.weight, 0);
    if (totalWeight <= 0) return;

    const scale = totalDuration / totalWeight;
    let accumulated = 0;

    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      s.startTime = accumulated;
      if (i === sentences.length - 1) {
        s.endTime = totalDuration;
      } else {
        s.endTime = Math.min(totalDuration, accumulated + s.weight * scale);
      }
      accumulated = s.endTime;
    }
  }

  static findSentenceIndex(sentences: NoteSentence[], currentTime: number): number {
    if (!sentences.length) return -1;
    for (let i = 0; i < sentences.length; i++) {
      if (currentTime >= sentences[i].startTime && currentTime < sentences[i].endTime) {
        return i;
      }
    }
    if (sentences.some(s => s.timingSource)) return -1;
    if (currentTime >= sentences[sentences.length - 1].endTime) {
      return sentences.length - 1;
    }
    return currentTime < sentences[0].startTime ? -1 : 0;
  }
}

class NoteFloatingPlayer {
  app: App;
  plugin: NoteTtsPlugin;
  view: MarkdownView;
  file: TFile;
  audioFile: TFile;
  audio: HTMLAudioElement;

  private sentences: NoteSentence[] = [];
  private activeSentenceIndex: number = -1;
  private hasSpeechTiming = false;
  private timingPending = false;
  private destroyed = false;
  private timingStatusEl: HTMLElement | null = null;
  private isAutoScroll: boolean = true;
  private isCollapsed: boolean = false;
  private playbackRates = [1.0, 1.25, 1.5, 1.75, 2.0, 0.75];
  private currentRateIndex = 0;

  // DOM 节点引用
  private containerEl: HTMLElement | null = null;
  private sentenceTextEl: HTMLElement | null = null;
  private progressSlider: HTMLInputElement | null = null;
  private currentTimeEl: HTMLElement | null = null;
  private totalTimeEl: HTMLElement | null = null;
  private playPauseBtn: HTMLButtonElement | null = null;
  private speedBtn: HTMLButtonElement | null = null;
  private autoScrollBtn: HTMLButtonElement | null = null;

  private isDraggingSlider: boolean = false;
  private rafId: number | null = null;
  private cleanupFns: (() => void)[] = [];
  private progressiveTimer: number | null = null;

  constructor(app: App, plugin: NoteTtsPlugin, view: MarkdownView, file: TFile, audioFile: TFile, private progressive?: ProgressiveAudioPlayer) {
    this.app = app;
    this.plugin = plugin;
    this.view = view;
    this.file = file;
    this.audioFile = audioFile;
    this.isAutoScroll = plugin.settings.enableAutoScroll !== false;

    this.audio = new Audio();
    if (!progressive) this.audio.src = this.app.vault.getResourcePath(this.audioFile);
    this.audio.preload = "auto";
  }

  async init() {
    const content = await this.app.vault.read(this.file);
    if (this.destroyed) return;
    this.sentences = NoteSentenceAligner.parseSentences(
      content,
      this.file.basename,
      this.plugin.settings.includeTitleInAudio,
      this.plugin.settings.skipLinePatterns
    );

    this.timingPending = !this.progressive && this.plugin.settings.enableSpeechAlignment !== false;
    this.buildUI();
    if (this.progressive) {
      this.progressiveTimer = window.setInterval(() => this.updatePlaybackState(), 100);
      this.updatePlaybackState();
      return;
    }
    this.bindAudioEvents();
    this.bindDocumentClick();
    if (this.timingPending) void this.loadSpeechTiming(content);

    // 恢复记忆的播放进度（避免重新打开伴读播放器时从头播放）
    const savedTime = this.plugin.savedAudioPositions.get(this.audioFile.path);
    if (savedTime && savedTime > 0) {
      const restore = () => {
        if (!isNaN(this.playbackDuration) && savedTime < this.playbackDuration) {
          this.playbackTime = savedTime;
        }
      };
      this.audio.addEventListener("loadedmetadata", restore, { once: true });
      if (this.audio.readyState >= 1) {
        restore();
      }
    }

    this.audio.play().catch((err) => {
      console.warn("自动播放受限:", err);
    });
  }

  private get playbackTime() { return this.progressive ? this.progressive.position : this.audio.currentTime; }
  private set playbackTime(value: number) { if (this.progressive) this.progressive.seek(value); else this.audio.currentTime = value; }
  private get playbackDuration() { return this.progressive ? this.progressive.duration : this.audio.duration; }

  completeProgressive(saved: TFile, position: number, playing: boolean) {
    if (this.destroyed) return;
    if (this.progressiveTimer !== null) window.clearInterval(this.progressiveTimer);
    this.progressiveTimer = null;
    this.progressive = undefined;
    this.audioFile = saved;
    this.audio.src = this.app.vault.getResourcePath(saved);
    this.timingPending = this.plugin.settings.enableSpeechAlignment !== false;
    this.bindAudioEvents();
    this.bindDocumentClick();
    if (this.speedBtn) this.speedBtn.disabled = false;
    if (this.autoScrollBtn) this.autoScrollBtn.disabled = false;
    if (this.timingStatusEl) this.timingStatusEl.textContent = this.timingPending ? "语音对齐中" : "估算高亮";
    const restore = () => {
      this.audio.removeEventListener("loadedmetadata", restore);
      if (this.destroyed) return;
      this.audio.currentTime = Math.min(position, this.audio.duration || position);
      this.updatePlaybackState();
      if (playing) void this.audio.play().catch(() => {});
    };
    this.audio.addEventListener("loadedmetadata", restore, { once: true });
    this.cleanupFns.push(() => this.audio.removeEventListener("loadedmetadata", restore));
    if (this.audio.readyState >= 1) restore();
    if (this.timingPending) void this.app.vault.read(this.file).then(content => this.loadSpeechTiming(content));
  }

  private buildUI() {
    this.view.contentEl.setCssStyles({ position: "relative" });
    const existing = this.view.contentEl.querySelector(".podvoice-floating-bar");
    if (existing) existing.remove();

    this.containerEl = this.view.contentEl.createDiv({ cls: "podvoice-floating-bar" });

    // 1. 迷你折叠胶囊模式触发器
    const miniTrigger = this.containerEl.createDiv({ cls: "podvoice-floating-mini-trigger" });
    miniTrigger.createSpan({ cls: "podvoice-mini-pulse" });
    miniTrigger.createSpan({ text: "听笔记伴读中 · 点击展开" });
    miniTrigger.addEventListener("click", () => this.toggleCollapse(false));

    // 2. 完整伴读控制器主体
    const mainWrap = this.containerEl.createDiv({ cls: "podvoice-floating-main" });

    // 顶部行：当前朗读句子与定位按钮
    const sentenceRow = mainWrap.createDiv({ cls: "podvoice-floating-sentence-row" });
    this.timingStatusEl = sentenceRow.createSpan({ cls: "podvoice-current-sentence-badge", text: this.progressive ? "边听边生成" : this.timingPending ? "语音对齐中" : "估算高亮" });
    this.sentenceTextEl = sentenceRow.createSpan({
      cls: "podvoice-current-sentence-text",
      text: "准备播放中...",
    });
    this.sentenceTextEl.setAttribute("title", "点击在笔记中居中查看此句");
    this.sentenceTextEl.addEventListener("click", () => this.scrollToActiveSentence(true));

    const locateBtn = sentenceRow.createEl("button", {
      cls: "clickable-icon podvoice-btn-locate",
      attr: { "aria-label": "定位到当前句子", title: "定位到当前朗读句子" },
    });
    setIcon(locateBtn, "crosshair");
    locateBtn.addEventListener("click", () => this.scrollToActiveSentence(true));

    // 进度条行
    const progressRow = mainWrap.createDiv({ cls: "podvoice-floating-progress-row" });
    this.currentTimeEl = progressRow.createSpan({ cls: "podvoice-time-text", text: "00:00" });
    this.progressSlider = progressRow.createEl("input", {
      type: "range",
      cls: "podvoice-slider",
      attr: { min: "0", max: "100", value: "0", step: "0.1" },
    });
    this.totalTimeEl = progressRow.createSpan({ cls: "podvoice-time-text", text: "00:00" });

    this.progressSlider.addEventListener("input", () => {
      this.isDraggingSlider = true;
      if (this.playbackDuration && !isNaN(this.playbackDuration)) {
        const pct = Number(this.progressSlider?.value || 0) / 100;
        const seekTime = pct * this.playbackDuration;
        if (this.currentTimeEl) {
          this.currentTimeEl.textContent = this.formatTime(seekTime);
        }
      }
    });

    this.progressSlider.addEventListener("change", () => {
      if (this.playbackDuration && !isNaN(this.playbackDuration)) {
        const pct = Number(this.progressSlider?.value || 0) / 100;
        this.playbackTime = pct * this.playbackDuration;
      }
      this.isDraggingSlider = false;
    });

    // 控制按钮行
    const controlsRow = mainWrap.createDiv({ cls: "podvoice-floating-controls-row" });

    // 左侧：倍速与跟随开关
    const controlsLeft = controlsRow.createDiv({ cls: "podvoice-controls-left" });
    this.speedBtn = controlsLeft.createEl("button", {
      cls: "podvoice-btn-speed",
      text: "1.0x",
      attr: { "aria-label": "切换播放倍速", title: "点击切换播放倍速" },
    });
    this.speedBtn.disabled = Boolean(this.progressive);
    this.speedBtn.addEventListener("click", () => this.cycleSpeed());

    this.autoScrollBtn = controlsLeft.createEl("button", {
      cls: `podvoice-btn-autoscroll ${this.isAutoScroll ? "is-active" : ""}`,
      attr: { "aria-label": "自动跟随滚动", title: "点击切换是否自动平滑居中当前朗读句" },
    });
    this.autoScrollBtn.disabled = Boolean(this.progressive);
    this.autoScrollBtn.createSpan({ text: "📜 跟随" });
    this.autoScrollBtn.addEventListener("click", () => this.toggleAutoScroll());

    // 中间：核心播放控制按键
    const controlsCenter = controlsRow.createDiv({ cls: "podvoice-controls-center" });

    const prevBtn = controlsCenter.createEl("button", {
      cls: "clickable-icon podvoice-btn-seek",
      attr: { "aria-label": "上一句 / 快退 15 秒", title: "上一句 / 快退 15 秒" },
    });
    setIcon(prevBtn, "rotate-ccw");
    prevBtn.addEventListener("click", () => this.seekToPreviousSentence());

    this.playPauseBtn = controlsCenter.createEl("button", {
      cls: "clickable-icon podvoice-btn-play-pause",
      attr: { "aria-label": "播放 / 暂停", title: "播放 / 暂停" },
    });
    setIcon(this.playPauseBtn, "play");
    this.playPauseBtn.addEventListener("click", () => this.togglePlayPause());

    const nextBtn = controlsCenter.createEl("button", {
      cls: "clickable-icon podvoice-btn-seek",
      attr: { "aria-label": "下一句 / 快进 15 秒", title: "下一句 / 快进 15 秒" },
    });
    setIcon(nextBtn, "rotate-cw");
    nextBtn.addEventListener("click", () => this.seekToNextSentence());

    // 右侧：折叠与关闭
    const controlsRight = controlsRow.createDiv({ cls: "podvoice-controls-right" });

    const collapseBtn = controlsRight.createEl("button", {
      cls: "clickable-icon podvoice-btn-action",
      attr: { "aria-label": "折叠为悬浮迷你胶囊", title: "折叠为迷你胶囊 (不遮挡正文)" },
    });
    setIcon(collapseBtn, "chevron-down");
    collapseBtn.addEventListener("click", () => this.toggleCollapse(true));

    const closeBtn = controlsRight.createEl("button", {
      cls: "clickable-icon podvoice-btn-action",
      attr: { "aria-label": "关闭伴读播放器", title: "退出伴读播放" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.destroy());
  }

  private async loadSpeechTiming(content: string) {
    try {
      const timing = await this.plugin.getSpeechTiming(this.audioFile);
      if (this.destroyed) return;
      if (await this.app.vault.read(this.file) !== content) throw new Error("笔记已更新，请重新打开播放器对齐。");
      if (this.destroyed) return;
      const aligned = this.sentences.map(s => ({ ...s }));
      const count = alignSentencesToSpeech(aligned, timing.tokens, s => this.plugin.prepareSentenceForAlignment(s.text));
      if (!count) throw new Error("识别结果与笔记未可靠匹配。");
      this.sentences = aligned;
      this.hasSpeechTiming = true;
      this.activeSentenceIndex = -1;
      if (this.timingStatusEl) {
        this.timingStatusEl.textContent = count === aligned.length ? "语音已对齐" : `语音对齐 ${count}/${aligned.length}`;
        this.timingStatusEl.title = "按音频识别的字词时间戳定位；未匹配的句子不猜测位置。";
      }
    } catch (error) {
      if (this.destroyed) return;
      if (this.timingStatusEl) {
        this.timingStatusEl.textContent = "估算高亮";
        this.timingStatusEl.title = error instanceof Error ? error.message : String(error);
      }
      console.warn("语音对齐未就绪，使用估算高亮:", error);
    } finally {
      this.timingPending = false;
      if (!this.destroyed) this.updatePlaybackState();
    }
  }

  private bindAudioEvents() {
    const onLoadedMetadata = () => {
      if (this.playbackDuration && !isNaN(this.playbackDuration)) {
        if (!this.hasSpeechTiming) NoteSentenceAligner.alignTimestamps(this.sentences, this.playbackDuration);
        if (this.totalTimeEl) {
          this.totalTimeEl.textContent = this.formatTime(this.playbackDuration);
        }
      }
    };
    this.audio.addEventListener("loadedmetadata", onLoadedMetadata);
    this.audio.addEventListener("durationchange", onLoadedMetadata);
    if (this.audio.readyState >= 1) {
      onLoadedMetadata();
    }
    this.cleanupFns.push(() => {
      this.audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      this.audio.removeEventListener("durationchange", onLoadedMetadata);
    });

    const onPlay = () => {
      const cardAudio = this.view.containerEl.querySelector<HTMLAudioElement>(".podvoice-card-audio");
      if (cardAudio && !cardAudio.paused) {
        cardAudio.pause();
      }
      if (this.playPauseBtn) {
        this.playPauseBtn.empty();
        setIcon(this.playPauseBtn, "pause");
      }
      this.startPlaybackTicker();
      this.plugin.refreshAllInlineButtonsDebounced(60);
    };

    const onPause = () => {
      this.stopPlaybackTicker();
      if (this.playPauseBtn) {
        this.playPauseBtn.empty();
        setIcon(this.playPauseBtn, "play");
      }
      this.plugin.refreshAllInlineButtonsDebounced(60);
    };

    const onEnded = () => {
      this.stopPlaybackTicker();
      this.plugin.savedAudioPositions.set(this.audioFile.path, 0);
      if (this.playPauseBtn) {
        this.playPauseBtn.empty();
        setIcon(this.playPauseBtn, "play");
      }
      this.plugin.refreshAllInlineButtonsDebounced(60);
    };

    const onTimeUpdate = () => {
      this.updatePlaybackState();
    };

    this.audio.addEventListener("timeupdate", onTimeUpdate);
    this.audio.addEventListener("play", onPlay);
    this.audio.addEventListener("pause", onPause);
    this.audio.addEventListener("ended", onEnded);
    this.cleanupFns.push(() => {
      this.stopPlaybackTicker();
      this.audio.removeEventListener("timeupdate", onTimeUpdate);
      this.audio.removeEventListener("play", onPlay);
      this.audio.removeEventListener("pause", onPause);
      this.audio.removeEventListener("ended", onEnded);
    });
  }

  private startPlaybackTicker() {
    this.stopPlaybackTicker();
    const tick = () => {
      if (!this.audio.paused && !this.audio.ended) {
        this.updatePlaybackState();
        this.rafId = requestAnimationFrame(tick);
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopPlaybackTicker() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private updatePlaybackState() {
    if (this.progressive) {
      if (this.timingStatusEl) this.timingStatusEl.textContent = this.progressive.status;
      if (this.sentenceTextEl) this.sentenceTextEl.textContent = this.file.basename;
      if (this.totalTimeEl) this.totalTimeEl.textContent = `已生成 ${this.formatTime(this.playbackDuration)}`;
      if (this.currentTimeEl) this.currentTimeEl.textContent = this.formatTime(this.playbackTime);
      if (this.progressSlider && !this.isDraggingSlider) this.progressSlider.value = String(this.playbackDuration ? this.playbackTime / this.playbackDuration * 100 : 0);
      if (this.playPauseBtn) setIcon(this.playPauseBtn, this.progressive.isPlaying ? "pause" : "play");
      return;
    }
    if (!this.playbackDuration || isNaN(this.playbackDuration)) return;

    if (!isNaN(this.playbackTime) && this.playbackTime > 0) {
      this.plugin.savedAudioPositions.set(this.audioFile.path, this.playbackTime);
    }

    if (!this.isDraggingSlider && this.progressSlider && this.currentTimeEl) {
      const pct = (this.playbackTime / this.playbackDuration) * 100;
      this.progressSlider.value = pct.toFixed(1);
      this.currentTimeEl.textContent = this.formatTime(this.playbackTime);
    }

    if (this.timingPending) return;
    // Manual correction only applies to the estimated fallback.
    const lookupTime = this.playbackTime + this.getHighlightOffset();
    const idx = NoteSentenceAligner.findSentenceIndex(this.sentences, lookupTime);
    if (idx < 0) {
      this.activeSentenceIndex = -1;
      if (this.sentenceTextEl) this.sentenceTextEl.textContent = "";
      this.clearSentenceHighlight();
      return;
    }
    if (idx !== this.activeSentenceIndex && idx >= 0) {
      this.activeSentenceIndex = idx;
      const currentSentence = this.sentences[idx];
      if (this.sentenceTextEl) {
        this.sentenceTextEl.textContent = currentSentence.text;
      }
      if (this.plugin.settings.enableSentenceHighlight !== false) {
        this.highlightSentence(currentSentence);
      }
      if (this.isAutoScroll && this.plugin.settings.enableAutoScroll !== false) {
        this.scrollToSentence(currentSentence);
      }
    }
  }

  private bindDocumentClick() {
    this.view.containerEl.addClass("podvoice-interactive-mode");

    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      if (
        (this.containerEl && this.containerEl.contains(target)) ||
        target.closest(
          ".podvoice-floating-bar, .podvoice-podcast-card, .podvoice-mowen-pill, button, input, a, .view-header, .clickable-icon"
        )
      ) {
        return;
      }

      if (this.timingPending || !this.sentences.some(s => s.endTime > 0)) {
        return;
      }

      const lineEl = target.closest<HTMLElement>(".cm-line");
      const pEl = target.closest<HTMLElement>(".markdown-rendered p, .markdown-rendered h1, .markdown-rendered h2, .markdown-rendered h3, .markdown-rendered h4, .markdown-rendered li, .markdown-rendered blockquote");
      const el = lineEl || pEl;
      if (!el || !el.textContent) return;

      const clickedText = el.textContent.trim();
      if (!clickedText || clickedText.length < 2) return;

      for (let i = 0; i < this.sentences.length; i++) {
        const s = this.sentences[i];
        if (clickedText.includes(s.raw.slice(0, 10)) || s.text.includes(clickedText.slice(0, 10))) {
          this.seekToSentence(i);
          break;
        }
      }
    };

    this.view.containerEl.addEventListener("click", onClick);
    this.cleanupFns.push(() => {
      this.view.containerEl.removeClass("podvoice-interactive-mode");
      this.view.containerEl.removeEventListener("click", onClick);
    });
  }

  private getScrollContainer(): HTMLElement | null {
    return (
      this.view.containerEl.querySelector(".cm-scroller, .markdown-preview-view") ||
      this.view.containerEl.querySelector(".view-content")
    );
  }

  private getActiveHighlightEl(): HTMLElement | null {
    return this.view.containerEl.querySelector<HTMLElement>(".cm-line.podvoice-active-line, .podvoice-sentence-active");
  }

  private scrollElementToCenter(el: HTMLElement, smooth = true) {
    const scroller = this.getScrollContainer();
    if (!scroller) {
      el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
      return;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    // 考虑底部浮动伴读控制栏的占用高度（展开约 80px + 边距，折叠约 45px）
    const bottomBarPadding = this.isCollapsed ? 35 : 95;
    const effectiveHeight = Math.max(100, scrollerRect.height - bottomBarPadding);
    // 黄金视线阅读居中位：有效视口高度的 45%（正中央偏上一点，最舒适的聚焦视线）
    const targetCenterFromTop = effectiveHeight * 0.45;

    // 当前元素中心相对于 scroller 顶部的当前垂直偏移
    const currentCenterFromTop = (elRect.top - scrollerRect.top) + (elRect.height / 2);
    const delta = currentCenterFromTop - targetCenterFromTop;

    // 如果微调偏差小于 6px，说明已处于黄金中心线，无需微小抖动
    if (Math.abs(delta) < 6) return;

    const targetScrollTop = scroller.scrollTop + delta;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const clampedScrollTop = Math.max(0, Math.min(targetScrollTop, maxScrollTop));

    try {
      scroller.scrollTo({
        top: clampedScrollTop,
        behavior: smooth ? "smooth" : "auto",
      });
    } catch {
      scroller.scrollTop = clampedScrollTop;
    }
  }

  private clearSentenceHighlight() {
    this.view.containerEl.querySelectorAll(".cm-line.podvoice-active-line").forEach((el) => {
      el.removeClass("podvoice-active-line");
    });
    this.view.containerEl.querySelectorAll(".podvoice-sentence-active").forEach((el) => {
      el.removeClass("podvoice-sentence-active");
    });
  }

  private highlightSentence(sentence: NoteSentence): HTMLElement | null {
    this.clearSentenceHighlight();
    const rawClean = sentence.raw.trim();
    const matchKey = rawClean.length > 15 ? rawClean.slice(0, 15) : rawClean;
    const cleanSentenceText = sentence.text.trim().slice(0, 15);
    const cleanRawWithoutMd = sentence.raw.replace(/^[#\-*\d.\s>]+/, "").trim().slice(0, 15);

    let activeEl: HTMLElement | null = null;

    // 1. Live Preview / 编辑器行高亮（多重特征渐进匹配，确保 100% 捕获）
    const lineEls = this.view.containerEl.querySelectorAll(".cm-line");
    const targetLineText = this.view.editor?.getLine?.(sentence.lineIndex)?.trim() || "";

    if (targetLineText && targetLineText.length > 2) {
      const lineShort = targetLineText.slice(0, 15);
      for (let i = 0; i < lineEls.length; i++) {
        const el = lineEls[i] as HTMLElement;
        if (el.textContent && el.textContent.includes(lineShort)) {
          el.addClass("podvoice-active-line");
          activeEl = el;
          break;
        }
      }
    }

    if (!activeEl && cleanSentenceText && cleanSentenceText.length >= 2) {
      for (let i = 0; i < lineEls.length; i++) {
        const el = lineEls[i] as HTMLElement;
        if (el.textContent && el.textContent.includes(cleanSentenceText)) {
          el.addClass("podvoice-active-line");
          activeEl = el;
          break;
        }
      }
    }

    if (!activeEl && cleanRawWithoutMd && cleanRawWithoutMd.length >= 2) {
      for (let i = 0; i < lineEls.length; i++) {
        const el = lineEls[i] as HTMLElement;
        if (el.textContent && el.textContent.includes(cleanRawWithoutMd)) {
          el.addClass("podvoice-active-line");
          activeEl = el;
          break;
        }
      }
    }

    if (!activeEl && matchKey) {
      for (let i = 0; i < lineEls.length; i++) {
        const el = lineEls[i] as HTMLElement;
        if (el.textContent && el.textContent.includes(matchKey)) {
          el.addClass("podvoice-active-line");
          activeEl = el;
          break;
        }
      }
    }

    // 2. 阅读视图段落高亮
    const renderedEl = this.view.containerEl.querySelector(".markdown-rendered");
    if (renderedEl) {
      const paragraphs = renderedEl.querySelectorAll("p, h1, h2, h3, h4, li, blockquote");
      for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs[i] as HTMLElement;
        if (
          p.textContent &&
          ((cleanSentenceText && p.textContent.includes(cleanSentenceText)) ||
            (matchKey && p.textContent.includes(matchKey)))
        ) {
          p.addClass("podvoice-sentence-active");
          if (!activeEl) activeEl = p;
          break;
        }
      }
    }

    return activeEl;
  }

  scrollToSentence(sentence: NoteSentence, smooth = true) {
    let activeEl = this.getActiveHighlightEl();

    if (activeEl) {
      this.scrollElementToCenter(activeEl, smooth);
      return;
    }

    // 若当前目标行尚未渲染在 DOM 中（CodeMirror 6 虚拟视口），先调度 editor.scrollIntoView 将其拉入视口渲染区
    if (this.view.editor && sentence.lineIndex >= 0) {
      try {
        this.view.editor.scrollIntoView(
          { from: { line: sentence.lineIndex, ch: 0 }, to: { line: sentence.lineIndex, ch: 0 } },
          true
        );
      } catch { /* The media or view may already have been disposed. */ }
    }

    // 在下一帧（DOM 已被 CodeMirror 挂载渲染）后，重新高亮并精细平滑居中校准
    requestAnimationFrame(() => {
      const el = this.highlightSentence(sentence) || this.getActiveHighlightEl();
      if (el) {
        this.scrollElementToCenter(el, smooth);
      }
    });
  }

  scrollToActiveSentence(force = false) {
    if (this.activeSentenceIndex < 0 || this.activeSentenceIndex >= this.sentences.length) return;
    const sentence = this.sentences[this.activeSentenceIndex];
    this.scrollToSentence(sentence);
    new Notice(`已定位到第 ${this.activeSentenceIndex + 1} 句`);
  }

  togglePlayPause() {
    if (this.progressive) { this.progressive.toggle(); this.updatePlaybackState(); return; }
    if (this.audio.paused) {
      this.audio.play().catch(() => {});
      new Notice("▶️ 伴读播放中");
    } else {
      this.audio.pause();
      new Notice("⏸️ 已暂停播放");
    }
  }

  private getHighlightOffset(): number {
    if (this.hasSpeechTiming) return 0;
    const offset = this.plugin.settings.highlightLeadTime;
    return (Number.isFinite(offset) ? offset : 0) * (this.audio.playbackRate || 1);
  }

  private getSentenceSeekTime(sentence: NoteSentence): number {
    // Delayed highlighting must seek to the corrected boundary too. A positive
    // visual lead must never skip the beginning of the spoken sentence.
    const time = sentence.startTime - Math.min(0, this.getHighlightOffset());
    return Math.min(this.playbackDuration, Math.max(0, time));
  }

  seekToSentence(index: number) {
    if (index < 0 || index >= this.sentences.length) return;
    const target = this.sentences[index];
    if (this.timingPending || target.timingSource === "unmatched") {
      new Notice(this.timingPending ? "语音时间戳正在生成，请稍候。" : "这句话未可靠匹配到音频，暂不能精确跳转。");
      return;
    }
    this.playbackTime = this.getSentenceSeekTime(target);
    this.activeSentenceIndex = index;
    if (this.sentenceTextEl) {
      this.sentenceTextEl.textContent = target.text;
    }
    this.highlightSentence(target);
    this.scrollToSentence(target);
    if (this.audio.paused) {
      this.audio.play().catch(() => {});
    }
  }

  seekToPreviousSentence() {
    if (this.progressive) { this.progressive.seek(this.playbackTime - 15); return; }
    if (this.hasSpeechTiming) {
      const previous = this.sentences.filter(s => s.timingSource === "speech" && s.startTime < this.playbackTime - .1);
      const target = previous[previous.length - 1];
      if (target) this.seekToSentence(this.sentences.indexOf(target));
      return;
    }
    if (this.playbackTime > 3 && this.activeSentenceIndex >= 0) {
      const current = this.sentences[this.activeSentenceIndex];
      const startTime = this.getSentenceSeekTime(current);
      if (this.playbackTime - startTime > 2) {
        this.playbackTime = startTime;
        return;
      }
    }
    const prevIdx = Math.max(0, this.activeSentenceIndex - 1);
    this.seekToSentence(prevIdx);
  }

  seekToNextSentence() {
    if (this.progressive) { this.progressive.seek(this.playbackTime + 15); return; }
    if (this.hasSpeechTiming) {
      const next = this.sentences.findIndex(s => s.timingSource === "speech" && s.startTime > this.playbackTime + .1);
      if (next >= 0) this.seekToSentence(next);
      return;
    }
    const nextIdx = Math.min(this.sentences.length - 1, this.activeSentenceIndex + 1);
    this.seekToSentence(nextIdx);
  }

  private cycleSpeed() {
    this.currentRateIndex = (this.currentRateIndex + 1) % this.playbackRates.length;
    const rate = this.playbackRates[this.currentRateIndex];
    this.audio.playbackRate = rate;
    if (this.speedBtn) {
      this.speedBtn.textContent = `${rate}x`;
    }
    new Notice(`播放倍速：${rate}x`);
  }

  private toggleAutoScroll() {
    this.isAutoScroll = !this.isAutoScroll;
    if (this.autoScrollBtn) {
      this.autoScrollBtn.toggleClass("is-active", this.isAutoScroll);
    }
    new Notice(this.isAutoScroll ? "已开启自动跟随滚动" : "已关闭自动跟随滚动");
  }

  private toggleCollapse(collapsed: boolean) {
    this.isCollapsed = collapsed;
    if (this.containerEl) {
      this.containerEl.toggleClass("is-collapsed", this.isCollapsed);
    }
  }

  private formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0) return "00:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.progressiveTimer !== null) window.clearInterval(this.progressiveTimer);
    const progressive = this.progressive;
    this.progressive = undefined;
    progressive?.destroy();
    this.stopPlaybackTicker();
    try {
      this.audio.pause();
      this.audio.src = "";
    } catch { /* The media or view may already have been disposed. */ }

    this.view.containerEl.querySelectorAll(".cm-line.podvoice-active-line").forEach((el) => {
      el.removeClass("podvoice-active-line");
    });
    this.view.containerEl.querySelectorAll(".podvoice-sentence-active").forEach((el) => {
      el.removeClass("podvoice-sentence-active");
    });

    for (const fn of this.cleanupFns) {
      try { fn(); } catch { /* The media or view may already have been disposed. */ }
    }
    this.cleanupFns = [];

    if (this.containerEl) {
      this.containerEl.remove();
      this.containerEl = null;
    }

    if (this.plugin.activeFloatingPlayer === this) {
      this.plugin.activeFloatingPlayer = null;
    }
  }
}

class GenerationLogsModal extends Modal {
  async onOpen() {
    this.contentEl.createEl("h2", { text: "最近生成日志" });
    this.contentEl.createEl("p", { text: "最近 50 次。完整记录保存在仓库 TTS Logs 文件夹；字数为清洗后的字符数，分段数为本次计划提交的总段数。" });
    const list = this.contentEl.createDiv();
    try {
      const adapter = this.app.vault.adapter;
      if (!await adapter.exists("TTS Logs")) {
        list.createEl("p", { text: "暂无记录。下次生成语音后会自动记录。" });
        return;
      }
      const folders = (await adapter.list("TTS Logs")).folders.sort().reverse();
      let count = 0;
      let unreadable = 0;
      const statuses: Record<GenerationLog["status"], string> = { success: "成功", failed: "失败", pending: "待完成", running: "未结束（可能仍在生成或曾中断）" };
      for (const folder of folders) {
        const files = (await adapter.list(folder)).files.filter(path => path.endsWith(".json")).sort().reverse();
        for (const path of files) {
          if (count >= 50) break;
          let log: GenerationLog;
          try {
            log = JSON.parse(await adapter.read(path)) as GenerationLog;
            if (log.version !== 1 || !Object.prototype.hasOwnProperty.call(statuses, log.status)) throw new Error("Invalid log");
          } catch { unreadable++; continue; }
          const entry = list.createEl("details");
          entry.createEl("summary", { text: `${statuses[log.status]} · ${log.sourcePath || "音色试听"} · ${formatGenerationDuration(log.durationMs)}` });
          entry.createEl("p", { text: `${new Date(log.startedAt).toLocaleString()} · ${log.provider} · ${log.model} · ${log.voiceName}` });
          entry.createEl("p", { text: `${log.characterCount} 字符 · ${log.chunkCount} 段${log.durationBasis === "wall-clock" ? " · 耗时含后台等待及稍后检查的时间" : ""}` });
          if (log.outputPath) entry.createEl("p", { text: `音频：${log.outputPath}` });
          if (log.modelWeights) entry.createEl("p", { text: `GPT：${log.modelWeights.gpt}；SoVITS：${log.modelWeights.sovits}` });
          if (log.error) entry.createEl("p", { text: `详情：${log.error}` });
          entry.createEl("p", { text: `日志：${path}` });
          count++;
        }
        if (count >= 50) break;
      }
      if (!count) list.createEl("p", { text: "暂无可读取的生成日志。" });
      if (unreadable) list.createEl("p", { text: `已跳过 ${unreadable} 份无法读取的日志。` });
    } catch (error) {
      list.createEl("p", { text: `日志读取失败：${errorMessage(error)}` });
    }
  }

  onClose() { this.contentEl.empty(); }
}

class TtsStatusModal extends Modal {
  private statusEl: HTMLElement;
  private detailEl: HTMLElement;

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("note-tts-status-modal");
    contentEl.createEl("h2", { text: "正在生成语音" });
    contentEl.createDiv({ cls: "note-tts-spinner" });
    this.statusEl = contentEl.createEl("div", {
      text: "正在准备...",
      cls: "note-tts-status-text",
    });
    this.detailEl = contentEl.createEl("div", {
      text: "请保持 Obsidian 打开。本地多段生成会在首段就绪后提供播放器；完整音频保存后会提示。",
      cls: "note-tts-status-detail",
    });
  }

  setStatus(message: string) {
    if (this.statusEl) {
      this.statusEl.setText(message);
    }
  }

  setError(message: string) {
    this.contentEl.removeClass("is-loading");
    this.contentEl.addClass("has-error");
    if (this.statusEl) {
      this.statusEl.setText("生成失败");
    }
    if (this.detailEl) {
      this.detailEl.setText(message);
    }
  }
}

class CleanedTextPreviewModal extends Modal {
  private text: string;

  constructor(app: App, text: string) {
    super(app);
    this.text = text;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("note-tts-preview-modal");
    contentEl.createEl("h2", { text: "朗读文本预览" });
    contentEl.createEl("textarea", {
      text: this.text,
      cls: "note-tts-preview-text",
      attr: {
        readonly: "true",
      },
    });
  }
}

class AudioResultModal extends Modal {
  private file: TFile;
  private sourceFile: TFile | null = null;
  private plugin: NoteTtsPlugin | null = null;
  private dragCleanup: (() => void) | null = null;

  constructor(app: App, file: TFile, sourceFile?: TFile | null, plugin?: NoteTtsPlugin, private startTime = 0) {
    super(app);
    this.file = file;
    this.sourceFile = sourceFile || null;
    this.plugin = plugin || null;
  }

  onOpen() {
    const { contentEl } = this;
    this.plugin?.stopEarlyPlayback();
    this.modalEl.addClass("note-tts-draggable-modal");
    contentEl.addClass("note-tts-modal");
    const title = contentEl.createEl("h2", { text: "🎧 听笔记 (Note Audio)", cls: "note-tts-drag-handle" });
    this.enableDrag(title);

    // 来源笔记双向关联展示卡片
    const noteCard = contentEl.createDiv({ cls: "note-tts-source-card" });
    let linkedNote = this.sourceFile;

    if (!linkedNote) {
      const match = this.file.basename.match(/^(.*?)-\d{4}-\d{2}-\d{2}T/);
      const noteBaseName = match ? match[1] : this.file.basename;
      const found = this.app.vault.getMarkdownFiles().find((f) => f.basename === noteBaseName);
      if (found) {
        linkedNote = found;
      }
    }

    if (linkedNote) {
      const noteInfo = noteCard.createDiv({ cls: "note-tts-source-info" });
      noteInfo.createSpan({ text: "📄 关联笔记：", cls: "note-tts-source-label" });
      const noteLink = noteInfo.createEl("a", { text: linkedNote.basename, cls: "note-tts-source-link" });
      noteLink.addEventListener("click", (e) => {
        e.preventDefault();
        void this.app.workspace.openLinkText(linkedNote.path, "", false).catch(error => new Notice(errorMessage(error)));
        new Notice(`已打开笔记：${linkedNote.basename}`);
      });
      const jumpBtn = noteCard.createEl("button", { text: "打开笔记", cls: "mod-cta note-tts-jump-btn" });
      jumpBtn.addEventListener("click", () => {
        void this.app.workspace.openLinkText(linkedNote.path, "", false).catch(error => new Notice(errorMessage(error)));
        this.close();
      });
    } else {
      noteCard.createDiv({ text: `📁 文件：${this.file.name}`, cls: "note-tts-path" });
    }

    const audio = contentEl.createEl("audio", {
      attr: {
        controls: "true",
        src: this.app.vault.getResourcePath(this.file),
        preload: "metadata",
      },
    });
    if (this.startTime > 0) {
      audio.addEventListener("loadedmetadata", () => {
        if (this.startTime < audio.duration) audio.currentTime = this.startTime;
      }, { once: true });
    }

    // 倍速播放控制
    const speedBar = contentEl.createDiv({ cls: "note-tts-speed-bar" });
    speedBar.createSpan({ text: "倍速：", cls: "note-tts-speed-label" });
    const speeds = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
    speeds.forEach((s) => {
      const btn = speedBar.createEl("button", {
        text: `${s}x`,
        cls: s === 1.0 ? "note-tts-speed-btn is-active" : "note-tts-speed-btn",
      });
      btn.addEventListener("click", () => {
        audio.playbackRate = s;
        speedBar.querySelectorAll(".note-tts-speed-btn").forEach((b) => b.removeClass("is-active"));
        btn.addClass("is-active");
      });
    });

    // 快进快退 15 秒控制
    const seekControls = contentEl.createDiv({ cls: "note-tts-seek-controls" });
    const backBtn = seekControls.createEl("button", { text: "⏪ 快退 15s", cls: "note-tts-seek-btn" });
    backBtn.addEventListener("click", () => {
      audio.currentTime = Math.max(0, audio.currentTime - 15);
    });
    const fwdBtn = seekControls.createEl("button", { text: "⏩ 快进 15s", cls: "note-tts-seek-btn" });
    fwdBtn.addEventListener("click", () => {
      audio.currentTime = Math.min(audio.duration || 999999, audio.currentTime + 15);
    });

    const actions = contentEl.createDiv({ cls: "note-tts-actions" });
    new Setting(actions)
      .addButton((button) =>
        button
          .setButtonText("打开对应笔记")
          .setDisabled(!linkedNote)
          .onClick(() => {
            if (linkedNote) {
              void this.app.workspace.openLinkText(linkedNote.path, "", false).catch(error => new Notice(errorMessage(error)));
              this.close();
            }
          })
      )
      .addButton((button) =>
        button
          .setButtonText("打开音频文件")
          .onClick(() => this.app.workspace.openLinkText(this.file.path, "", true))
      )
      .addButton((button) =>
        button
          .setButtonText("复制路径")
          .onClick(async () => {
            await navigator.clipboard.writeText(this.file.path);
            new Notice("已复制音频路径。");
          })
      )
      .addButton((button) =>
        button
          .setButtonText("复制嵌入语法")
          .onClick(async () => {
            await navigator.clipboard.writeText(`![[${this.file.path}]]`);
            new Notice("已复制 ![[...]] 语法。");
          })
      )
      .addButton((button) =>
        button
          .setButtonText("🔄 重新生成语音")
          .setDisabled(!linkedNote || !this.plugin)
          .onClick(async () => {
            if (linkedNote && this.plugin) {
              this.close();
              await this.plugin.synthesizeFile(linkedNote);
            }
          })
      );

    audio.focus();
    audio.play().catch(() => {});
  }

  onClose() {
    this.dragCleanup?.();
    this.dragCleanup = null;
    this.contentEl.empty();
  }

  private enableDrag(handle: HTMLElement) {
    const modal = this.modalEl;
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }

      const rect = modal.getBoundingClientRect();
      isDragging = true;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      modal.setCssStyles({
        position: "fixed",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        margin: "0",
      });
      handle.addClass("is-dragging");
      handle.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!isDragging) {
        return;
      }

      const nextLeft = clamp(startLeft + event.clientX - startX, 8, window.innerWidth - modal.offsetWidth - 8);
      const nextTop = clamp(startTop + event.clientY - startY, 8, window.innerHeight - modal.offsetHeight - 8);
      modal.setCssStyles({
        left: `${nextLeft}px`,
        top: `${nextTop}px`,
      });
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!isDragging) {
        return;
      }

      isDragging = false;
      handle.removeClass("is-dragging");
      handle.releasePointerCapture(event.pointerId);
    };

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);

    this.dragCleanup = () => {
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onPointerUp);
      handle.removeEventListener("pointercancel", onPointerUp);
    };
  }
}

// Settings hierarchy (§2.1, §3.6): daily voice/reading controls first, connection
// details and tuning folded away. Use Obsidian controls and theme tokens throughout.
interface NativeFolderDialog {
  showOpenDialog(options: { title: string; buttonLabel: string; defaultPath: string; properties: string[] }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

function getNativeFolderDialog(): NativeFolderDialog | undefined {
  // Obsidian desktop versions expose the native dialog through either remote bridge.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load optional desktop APIs only when this feature runs.
    const remote = require("@electron/remote") as { dialog?: NativeFolderDialog };
    if (remote.dialog) return remote.dialog;
  } catch { /* Older desktop builds expose electron.remote instead. */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load optional desktop APIs only when this feature runs.
    return (require("electron") as { remote?: { dialog?: NativeFolderDialog } }).remote?.dialog;
  } catch { return undefined; }
}

class NoteTtsSettingTab extends PluginSettingTab {
  plugin: NoteTtsPlugin;
  private language: "zh" | "en" = "zh";
  private folds = new Map<string, boolean>();
  private previewAudio: HTMLAudioElement | null = null;
  private previewUrl: string | null = null;
  private previewGeneration = 0;

  constructor(app: App, plugin: NoteTtsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();
    this.folds.clear();
    this.renderSettings();
  }

  hide() {
    this.previewGeneration++;
    this.stopPreview();
  }

  private label(zh: string, en: string) { return this.language === "zh" ? zh : en; }
  private t(key: SettingsTextKey) { return SETTINGS_TEXT[this.language][key]; }

  private section(parent: HTMLElement, title: string) {
    const section = parent.createDiv({ cls: "podvoice-settings-section" });
    new Setting(section).setName(title).setHeading();
    return section;
  }

  private disclosure(parent: HTMLElement, id: string, title: string, open = false) {
    const details = parent.createEl("details", { cls: "podvoice-settings-fold" });
    details.dataset.fold = id;
    details.open = this.folds.get(id) ?? open;
    details.createEl("summary", { text: title });
    return details.createDiv({ cls: "podvoice-settings-fold-body" });
  }

  private hasServiceConfiguration() {
    const s = this.plugin.settings;
    switch (s.provider) {
      case "volcengine": return Boolean(s.volcengineAppId?.trim() && s.volcengineAccessToken?.trim());
      case "gptsovits": return Boolean(s.gptsovitsEndpoint?.trim());
      case "minimax": return Boolean(s.minimaxApiKey?.trim());
      case "replicate": return Boolean(s.replicateApiToken?.trim());
      case "custom": return Boolean(s.customEndpoint?.trim());
    }
  }

  private renderSettings() {
    const { containerEl } = this;
    // Preserve open groups, scroll and keyboard focus when conditional rows change.
    containerEl.querySelectorAll<HTMLDetailsElement>("details[data-fold]").forEach(el => {
      this.folds.set(el.dataset.fold!, el.open);
    });
    const focused = containerEl.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const focusKey = focused?.dataset.settingFocus;
    const scrollTop = containerEl.scrollTop;
    containerEl.empty();
    containerEl.addClass("podvoice-settings");
    this.language = getSettingsDisplayLanguage(this.plugin.settings.settingsLanguage);
    const s = this.plugin.settings;

    const voice = this.section(containerEl, this.label("声音", "Voice"));
    const providerNames: Record<ProviderId, string> = {
      volcengine: this.label("火山引擎", "Volcengine"),
      gptsovits: this.label("GPT-SoVITS（本地 / 自建）", "GPT-SoVITS (local / self-hosted)"),
      minimax: "MiniMax", replicate: "Replicate", custom: "Custom HTTP",
    };
    const connection = this.disclosure(voice, "connection", this.label("服务连接", "Service connection") + " · " + providerNames[s.provider], !this.hasServiceConfiguration());
    this.selectSetting(connection, this.label("语音服务", "Speech service"), "", "provider", Object.entries(providerNames), true);
    this.displayProviderSettings(voice, connection);

    const reading = this.section(containerEl, this.label("听读体验", "Reading"));
    this.toggleSetting(reading, this.t("includeTitleInAudioName"), "", "includeTitleInAudio");
    this.toggleSetting(reading, this.t("enableSentenceHighlightName"), "", "enableSentenceHighlight", true);
    this.toggleSetting(reading, this.label("自动语音对齐", "Automatic speech alignment"),
      this.label("首次播放时离线提取语音时间戳并缓存；对齐成功后不使用手动延迟。", "Extract and cache audio timestamps locally on first playback; aligned playback ignores manual offsets."), "enableSpeechAlignment");
    this.toggleSetting(reading, this.t("enableAutoScrollName"), "", "enableAutoScroll");
    const appearance = this.disclosure(reading, "appearance", this.label("播放器与按钮", "Player and buttons"));
    this.toggleSetting(appearance, this.t("enableFloatingPlayerName"), "", "enableFloatingPlayer");
    this.toggleSetting(appearance, this.t("showPodcastCardName"), "", "showPodcastCard");
    this.toggleSetting(appearance, this.t("showTitleInlineButtonName"), "", "showTitleInlineButton", true);
    if (s.showTitleInlineButton) {
      this.selectSetting(appearance, this.t("titleButtonPositionName"), "", "titleButtonPosition", [
        ["right", this.t("posRight")], ["top", this.t("posTop")], ["bottom", this.t("posBottom")],
      ]);
    }
    this.toggleSetting(appearance, this.t("autoOpenPlayerAfterGenerateName"), "", "autoOpenPlayerAfterGenerate");
    if (s.enableSentenceHighlight) {
      this.selectSetting(appearance, this.t("highlightLeadTimeName"), this.t("highlightLeadTimeDesc"), "highlightLeadTime", [
        ...[-3, -2, -1.5, -1, -0.5].map(value => [String(value), this.label(`延后 ${-value} 秒`, `Delay ${-value} s`)] as [string, string]),
        ["0", this.label("不偏移（默认）", "No offset (default)")],
        ...[0.15, 0.35, 0.55, 0.75].map(value => [String(value), this.label(`提前 ${value} 秒`, `Advance ${value} s`)] as [string, string]),
      ], false, true);
    }

    this.displayStorageSettings(this.section(containerEl, this.label("音频保存", "Audio storage")));
    this.displayBatchSettings(this.section(containerEl, this.label("自动生成", "Automatic generation")));

    const advanced = this.disclosure(containerEl, "advanced", this.label("高级设置", "Advanced settings"));
    this.displayTextCleanupSettings(advanced);
    const lengths = this.disclosure(advanced, "lengths", this.label("文本长度与分段", "Text length and chunking"));
    this.numberSetting(lengths, this.t("maxCharactersName"), this.t("maxCharactersDesc"), "maxCharacters", 1);
    this.numberSetting(lengths, this.t("chunkCharactersName"), this.t("chunkCharactersDesc"), "chunkCharacters", 0);
    this.selectSetting(advanced, this.t("settingsLanguageName"), "", "settingsLanguage", [
      ["auto", this.t("settingsLanguageAuto")], ["zh", this.t("settingsLanguageZh")], ["en", this.t("settingsLanguageEn")],
    ], true);

    // Stable labels retain focus across rerenders without moving focus on initial open.
    containerEl.querySelectorAll<HTMLElement>(".setting-item").forEach(row => {
      const name = row.querySelector(".setting-item-name")?.textContent || "";
      row.querySelectorAll<HTMLElement>("input, select, textarea, button, [tabindex]").forEach((control, index) => {
        control.dataset.settingFocus = `${name}:${index}`;
        if (focusKey === control.dataset.settingFocus) control.focus({ preventScroll: true });
      });
    });
    containerEl.scrollTop = scrollTop;
  }

  private displayProviderSettings(voice: HTMLElement, connection: HTMLElement) {
    const s = this.plugin.settings;
    // Tuning is built separately so the main order remains connection → voice → test → tuning.
    const tuning = document.createElement("div");
    if (s.provider === "volcengine") {
      this.textSetting(connection, "App ID", this.t("volcengineAppIdDesc"), "volcengineAppId");
      this.textSetting(connection, "Access Token / API Key", this.t("volcengineAccessTokenDesc"), "volcengineAccessToken", true);
      this.selectSetting(voice, this.label("音色", "Voice"), "", "volcengineVoiceType", VOLCENGINE_VOICES.map(v => [v.id, v.name]), true);
      if (s.volcengineVoiceType === "custom") {
        this.textSetting(voice, this.label("自定义音色代码", "Custom voice ID"), this.t("volcengineCustomVoiceDesc"), "volcengineCustomVoiceType");
      }
      this.sliderSetting(voice, this.label("语速", "Speed"), "", "volcengineSpeed", 0.5, 2, 0.1);
      this.textSetting(tuning, "Cluster ID", this.t("volcengineClusterDesc"), "volcengineCluster");
      this.textSetting(tuning, this.label("接口地址", "Endpoint"), "", "volcengineEndpoint");
      this.numberSetting(tuning, this.label("音量", "Volume"), this.t("volcengineVolumeDesc"), "volcengineVolume", 0.1, 3);
      this.numberSetting(tuning, this.label("音调", "Pitch"), this.t("volcenginePitchDesc"), "volcenginePitch", 0.1, 3);
    } else if (s.provider === "gptsovits") {
      this.textSetting(connection, this.label("服务地址", "Endpoint"), this.t("gptsovitsEndpointDesc"), "gptsovitsEndpoint");
      this.selectSetting(voice, this.label("音色", "Voice"), "", "gptsovitsVoicePreset", GPTSOVITS_VOICES.map(v => [v.id, v.name]), true);
      if (s.gptsovitsVoicePreset === "custom") {
        this.textSetting(voice, this.t("gptsovitsCustomRefAudioName"), this.t("gptsovitsCustomRefAudioDesc"), "gptsovitsCustomRefAudio");
        this.textAreaSetting(voice, this.t("gptsovitsCustomPromptTextName"), this.t("gptsovitsCustomPromptTextDesc"), "gptsovitsCustomPromptText");
      }
      this.sliderSetting(voice, this.label("语速", "Speed"), "", "gptsovitsSpeed", 0.5, 2, 0.1);
      this.sliderSetting(tuning, this.label("采样温度", "Temperature"), this.t("gptsovitsTemperatureDesc"), "gptsovitsTemperature", 0.1, 1, 0.01);
    } else if (s.provider === "minimax") {
      this.textSetting(connection, "API Key", "", "minimaxApiKey", true);
      this.textSetting(voice, this.label("音色 ID", "Voice ID"), this.t("minimaxVoiceIdDesc"), "minimaxVoiceId");
      this.numberSetting(voice, this.label("语速", "Speed"), this.t("speedDesc"), "minimaxSpeed");
      this.textSetting(tuning, this.label("接口地址", "Endpoint"), this.t("minimaxEndpointDesc"), "minimaxEndpoint");
      this.textSetting(tuning, this.label("模型", "Model"), this.t("minimaxModelDesc"), "minimaxModel");
      this.textSetting(tuning, this.label("语言偏好", "Language preference"), this.t("minimaxLanguageBoostDesc"), "minimaxLanguageBoost");
      this.numberSetting(tuning, this.label("音量", "Volume"), this.t("volumeDesc"), "minimaxVolume");
      this.numberSetting(tuning, this.label("音调", "Pitch"), this.t("pitchDesc"), "minimaxPitch");
    } else if (s.provider === "replicate") {
      this.textSetting(connection, "API Token", "", "replicateApiToken", true);
      // Model changes alter the available voice controls; rerender on blur, not each keystroke.
      this.textSetting(connection, this.label("模型", "Model"), this.t("replicateModelDesc"), "replicateModel", false, true);
      if ((s.replicateModel || REPLICATE_MINIMAX_MODEL) === REPLICATE_MINIMAX_MODEL) {
        this.selectSetting(voice, this.label("音色", "Voice"), "", "replicateVoiceId", [
          [REPLICATE_CUSTOM_VOICE, this.label("自定义", "Custom")], ...REPLICATE_MINIMAX_VOICES.map(v => [v, v]),
        ], true);
        if (s.replicateVoiceId === REPLICATE_CUSTOM_VOICE) {
          this.textSetting(voice, this.label("自定义音色 ID", "Custom voice ID"), this.t("replicateCustomVoiceIdDesc"), "replicateCustomVoiceId");
        }
        this.numberSetting(voice, this.label("语速", "Speed"), this.t("replicateSpeedDesc"), "replicateSpeed", 0.5, 2);
        this.selectSetting(tuning, this.label("语言偏好", "Language preference"), "", "replicateLanguageBoost", [
          ["None", this.label("自动", "Auto")], ["Chinese", "中文"], ["Cantonese", "粤语"], ["English", "English"],
          ["Japanese", "日本語"], ["Korean", "한국어"], ["Spanish", "Español"], ["French", "Français"], ["German", "Deutsch"], ["Portuguese", "Português"],
        ]);
        this.selectSetting(tuning, this.label("情绪", "Emotion"), "", "replicateEmotion", [
          ["auto", this.label("自动", "Auto")], ["neutral", this.label("自然", "Neutral")], ["happy", this.label("愉快", "Happy")],
          ["sad", this.label("悲伤", "Sad")], ["angry", this.label("生气", "Angry")], ["fearful", this.label("害怕", "Fearful")],
          ["disgusted", this.label("厌恶", "Disgusted")], ["surprised", this.label("惊讶", "Surprised")],
          ["calm", this.label("平静", "Calm")], ["fluent", this.label("流畅", "Fluent")],
        ]);
        this.numberSetting(tuning, this.label("音量", "Volume"), this.t("replicateVolumeDesc"), "replicateVolume", 0, 10);
        this.numberSetting(tuning, this.label("音调", "Pitch"), this.t("replicatePitchDesc"), "replicatePitch", -12, 12);
      } else {
        this.textSetting(connection, this.label("模型版本", "Model version"), this.t("replicateVersionDesc"), "replicateVersion");
        this.textAreaSetting(connection, this.label("请求内容模板", "Input JSON template"), this.t("replicateInputTemplateDesc"), "replicateInputTemplate");
        voice.createEl("p", { cls: "setting-item-description", text: this.label("音色与语速由服务连接中的请求模板决定。", "Voice and speed are defined by the input template under Service connection.") });
      }
    } else {
      this.textSetting(connection, this.label("接口地址", "Endpoint"), this.t("customEndpointDesc"), "customEndpoint");
      this.textSetting(connection, this.label("请求方式", "Method"), this.t("customMethodDesc"), "customMethod");
      this.textAreaSetting(connection, this.label("请求头模板", "Headers JSON template"), this.t("customHeadersDesc"), "customHeaders");
      this.textAreaSetting(connection, this.label("请求内容模板", "Body JSON template"), this.t("customBodyTemplateDesc"), "customBodyTemplate");
      this.numberSetting(connection, this.label("自定义分段长度", "Custom chunk characters"), this.t("customChunkCharactersDesc"), "customChunkCharacters", 0);
      this.textSetting(connection, this.label("音频 URL 路径", "Audio URL path"), this.t("customAudioUrlPathDesc"), "customAudioUrlPath");
      this.textSetting(connection, this.label("音频 hex 路径", "Audio hex path"), this.t("customAudioHexPathDesc"), "customAudioHexPath");
      this.textSetting(connection, this.label("音频 base64 路径", "Audio base64 path"), this.t("customAudioBase64PathDesc"), "customAudioBase64Path");
      voice.createEl("p", { cls: "setting-item-description", text: this.label("音色与语速由服务连接中的请求模板决定。", "Voice and speed are defined by the request template under Service connection.") });
    }
    if (s.provider === "volcengine" || s.provider === "gptsovits") this.displayPreview(voice);
    if (tuning.childElementCount) {
      this.disclosure(voice, `voice-${s.provider}`, this.label("声音高级选项", "Voice tuning")).appendChild(tuning);
    }
  }

  private stopPreview() {
    this.previewAudio?.pause();
    this.previewAudio = null;
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = null;
  }

  private displayPreview(parent: HTMLElement) {
    const provider = this.plugin.settings.provider;
    new Setting(parent).setName(this.label("试听", "Preview"))
      .setDesc(this.label("发送一句测试文本，检查连接与声音。", "Send a short sample to check the connection and voice."))
      .addButton(button => button.setButtonText(this.label("试听声音", "Play sample")).setCta().onClick(async () => {
        const generation = ++this.previewGeneration;
        this.stopPreview();
        button.setDisabled(true).setButtonText(this.label("正在生成…", "Generating…"));
        try {
          const audio = provider === "volcengine" ? await this.plugin.testVolcengineVoice() : await this.plugin.testGptSoVitsVoice();
          if (!audio.data || generation !== this.previewGeneration || !button.buttonEl.isConnected) return;
          this.stopPreview();
          this.previewUrl = URL.createObjectURL(new Blob([audio.data], { type: audio.mimeType }));
          this.previewAudio = new Audio(this.previewUrl);
          this.previewAudio.addEventListener("ended", () => this.stopPreview(), { once: true });
          this.previewAudio.addEventListener("error", () => this.stopPreview(), { once: true });
          await this.previewAudio.play();
        } catch (error) {
          if (generation !== this.previewGeneration) return;
          this.stopPreview();
          new Notice(this.label("试听失败：", "Preview failed: ") + errorMessage(error), 8000);
        } finally {
          button.setDisabled(false).setButtonText(this.label("试听声音", "Play sample"));
        }
      }));
  }

  private displayStorageSettings(parent: HTMLElement) {
    const s = this.plugin.settings;
    this.textSetting(parent, this.label("保存位置", "Save audio to"), "", "outputFolder");
    // Read legacy combinations without rewriting them. Only an explicit choice changes policy.
    const mode = s.keepOnlyLatestAudio ? "latest" : s.audioNamingMode === "clean" ? "legacy" : "history";
    new Setting(parent).setName(this.label("历史版本", "Audio versions"))
      .setDesc(mode === "latest"
        ? this.label("重新生成时覆盖同名音频，并清理旧时间戳版本。", "Overwrite audio and remove old timestamped versions on regeneration.")
        : mode === "history"
        ? this.label("每次另存带时间戳的音频，保留历史版本。", "Save a new timestamped audio file each time.")
        : this.label("沿用原配置：覆盖同名音频，不清理已有历史。", "Keep the original behavior: overwrite audio without removing existing history."))
      .addDropdown(dropdown => {
        dropdown.addOption("latest", this.label("仅保留最新音频", "Keep latest only"))
          .addOption("history", this.label("保留历史版本", "Keep history"));
        if (mode === "legacy") dropdown.addOption("legacy", this.label("覆盖同名，保留已有历史（原配置）", "Overwrite, keep existing history (legacy)"));
        dropdown.setValue(mode).onChange(async value => {
          s.keepOnlyLatestAudio = value === "latest";
          s.audioNamingMode = value === "history" ? "timestamp" : "clean";
          await this.plugin.saveSettings();
          this.renderSettings();
        });
      });
    const association = this.disclosure(parent, "association", this.label("笔记关联", "Note linking"));
    this.toggleSetting(association, this.t("associateNoteFrontmatterName"), this.t("associateNoteFrontmatterDesc"), "associateNoteFrontmatter", true);
    if (s.associateNoteFrontmatter) this.textSetting(association, this.t("frontmatterKeyName"), this.t("frontmatterKeyDesc"), "frontmatterKey");
    this.selectSetting(association, this.t("autoEmbedInNoteName"), "", "autoEmbedInNote", [
      ["none", this.t("autoEmbedNone")], ["top", this.t("autoEmbedTop")], ["bottom", this.t("autoEmbedBottom")],
    ]);
    const storage = this.disclosure(parent, "storage-tools", this.label("空间与清理", "Storage and cleanup"));
    const stats = new Setting(storage).setName(this.label("音频占用", "Audio storage"));
    const refresh = async () => {
      stats.setDesc(this.label("正在计算…", "Calculating…"));
      try {
        const info = await this.plugin.getStorageStats();
        stats.setDesc(this.label(`${info.count} 个音频 · ${(info.totalBytes / 1048576).toFixed(2)} MB · ${info.orphanCount} 个孤立文件`, `${info.count} files · ${(info.totalBytes / 1048576).toFixed(2)} MB · ${info.orphanCount} orphaned`));
      } catch (error) { stats.setDesc(errorMessage(error)); }
    };
    // Scan only when the tools are opened, not whenever a voice or toggle changes.
    const details = storage.parentElement as HTMLDetailsElement;
    details.addEventListener("toggle", () => { if (details.open) void refresh(); });
    if (details.open) void refresh();
    for (const orphanOnly of [true, false]) {
      new Setting(storage).setName(orphanOnly ? this.label("清理孤立音频", "Remove orphaned audio") : this.label("清空音频", "Clear audio"))
        .setDesc(orphanOnly ? this.label("删除找不到对应笔记的音频文件。", "Delete audio files whose notes no longer exist.") : this.label("删除当前保存目录中的音频，保留笔记。", "Delete audio from the current output folder; keep notes."))
        .addButton(button => {
          button.setButtonText(orphanOnly ? this.label("扫描并清理", "Scan and clean") : this.label("清空…", "Clear…"));
          button.onClick(async () => {
            if (!orphanOnly && !confirm(this.label(`确定清空「${normalizeFolder(s.outputFolder)}」中的音频？笔记不会删除。`, `Clear audio in "${normalizeFolder(s.outputFolder)}"? Notes will be kept.`))) return;
            button.setDisabled(true);
            try {
              const count = orphanOnly ? await this.plugin.cleanOrphanAudios() : await this.plugin.clearAllAudios();
              new Notice(this.label(`已清理 ${count} 个音频文件。`, `Removed ${count} audio files.`));
              await refresh();
            } catch (error) { new Notice(errorMessage(error)); }
            finally { button.setDisabled(false); }
          });
        });
    }
  }

  private displayBatchSettings(parent: HTMLElement) {
    const s = this.plugin.settings;
    this.toggleSetting(parent, this.label("每天自动更新", "Update daily"), this.label("按设定时间生成目录内笔记的音频。", "Generate audio for notes in a folder at a scheduled time."), "batchScheduleEnabled", true);
    const batch = s.batchScheduleEnabled ? parent : this.disclosure(parent, "manual-batch", this.label("手动批量生成", "Manual batch generation"));
    this.displayNotesFolderSetting(batch);
    if (s.batchScheduleEnabled) {
      new Setting(batch).setName(this.label("更新时间", "Update time")).addText(text => {
        text.inputEl.type = "time";
        text.setValue(s.batchScheduleTime || "00:00").onChange(async value => {
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return;
          s.batchScheduleTime = value;
          await this.plugin.saveSettings();
        });
      });
      this.toggleSetting(batch, this.label("错过时间后补跑", "Catch up after a missed run"), this.label("下次启动或唤醒时，补跑今天错过的任务。", "Run today's missed task on startup or wake."), "batchCatchUpOnStartup");
    }
    const options = this.disclosure(batch, "batch-options", this.label("批量选项", "Batch options"));
    this.toggleSetting(options, this.label("包含子目录", "Include subfolders"), "", "batchIncludeSubfolders");
    this.toggleSetting(options, this.label("跳过未修改笔记", "Skip unchanged notes"), "", "batchSkipUnmodified");
    new Setting(batch).setName(this.label("立即生成目录音频", "Generate folder audio now"))
      .addButton(button => button.setButtonText(this.label("立即生成", "Generate now")).onClick(async () => {
        if (!s.batchSyncFolder?.trim()) { new Notice(this.label("请先选择笔记目录。", "Choose a notes folder first.")); return; }
        button.setDisabled(true);
        try { await this.plugin.syncFolderAudio(s.batchSyncFolder, false); }
        catch (error) { new Notice(errorMessage(error)); }
        finally { button.setDisabled(false); }
      }));
  }

  private displayNotesFolderSetting(parent: HTMLElement) {
    const s = this.plugin.settings;
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      const description = () => s.batchSyncFolder === "/"
        ? this.label("仓库根目录", "Vault root")
        : s.batchSyncFolder || this.label("尚未选择文件夹", "No folder selected");
      const setting = new Setting(parent).setName(this.label("笔记目录", "Notes folder")).setDesc(description());
      setting.addButton(button => button.setButtonText(this.label("选择文件夹…", "Choose folder…")).onClick(async () => {
        button.setDisabled(true);
        try {
          const dialog = getNativeFolderDialog();
          if (!dialog) throw new Error(this.label("无法打开系统文件夹选择窗口，请更新 Obsidian 后重试。", "Cannot open the system folder picker. Update Obsidian and try again."));
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load optional desktop APIs only when this feature runs.
          const path = require("path") as typeof import("path");
          const rootPath = adapter.getBasePath();
          const current = this.app.vault.getAbstractFileByPath(s.batchSyncFolder);
          const result = await dialog.showOpenDialog({
            title: this.label("选择笔记目录", "Choose notes folder"),
            buttonLabel: this.label("选择文件夹", "Choose folder"),
            defaultPath: current instanceof TFolder ? path.join(rootPath, current.path) : rootPath,
            properties: ["openDirectory"],
          });
          if (result.canceled || !result.filePaths[0]) return;
          const relative = path.relative(rootPath, result.filePaths[0]);
          if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(this.label("请选择当前 Obsidian 仓库内的文件夹。", "Choose a folder inside the current Obsidian vault."));
          }
          const selectedPath = relative.split(path.sep).join("/") || "/";
          const folder = selectedPath === "/" ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(selectedPath);
          if (!(folder instanceof TFolder)) throw new Error(this.label("该文件夹尚未被仓库识别，请稍后重试。", "This folder is not available in the vault yet. Try again shortly."));
          const previous = s.batchSyncFolder;
          s.batchSyncFolder = selectedPath;
          try { await this.plugin.saveSettings(); }
          catch (error) { s.batchSyncFolder = previous; throw error; }
          setting.setDesc(description());
        } catch (error) { new Notice(errorMessage(error)); }
        finally { button.setDisabled(false); }
      }));
      return;
    }
    // Mobile vaults have no local filesystem dialog; retain their vault folder list.
    const folders = this.app.vault.getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder && file.path !== "/")
      .map(folder => folder.path)
      .sort((a, b) => a.localeCompare(b, this.language === "zh" ? "zh-CN" : "en", { numeric: true }));
    const folderOptions: [string, string][] = [
      ["", this.label("请选择目录", "Choose a folder")],
      ["/", this.label("仓库根目录", "Vault root")],
      ...folders.map(path => [path, path] as [string, string]),
    ];
    if (s.batchSyncFolder && !folderOptions.some(([path]) => path === s.batchSyncFolder)) {
      folderOptions.push([s.batchSyncFolder, this.label(`原目录（请重新选择）：${s.batchSyncFolder}`, `Previous folder (choose again): ${s.batchSyncFolder}`)]);
    }
    this.selectSetting(parent, this.label("笔记目录", "Notes folder"), this.label("选择仓库内的笔记文件夹。", "Choose a notes folder in your vault."), "batchSyncFolder", folderOptions);
  }

  private displayTextCleanupSettings(parent: HTMLElement) {
    const s = this.plugin.settings;
    const custom = s.textCleanupMode === "custom" || TEXT_CLEANUP_KEYS.some(key => s[key] !== DEFAULT_SETTINGS[key]);
    new Setting(parent).setName(this.label("文本清理", "Text cleanup"))
      .setDesc(custom
        ? this.label("正在使用自定义规则。选择推荐会恢复下面这些清理规则。", "Using custom rules. Choosing Recommended resets the cleanup rules below.")
        : this.label("跳过链接、标签和笔记属性，优化朗读停顿。", "Skip links, tags and note properties; improve reading pauses."))
      .addDropdown(dropdown => dropdown
        .addOption("recommended", this.label("推荐", "Recommended"))
        .addOption("custom", this.label("自定义", "Custom"))
        .setValue(custom ? "custom" : "recommended")
        .onChange(async (value: "recommended" | "custom") => {
          if (value === "recommended") {
            for (const key of TEXT_CLEANUP_KEYS) Object.assign(s, { [key]: DEFAULT_SETTINGS[key] });
          }
          s.textCleanupMode = value;
          await this.plugin.saveSettings();
          this.renderSettings();
        }));
    if (!custom) return;
    const rules = parent.createDiv({ cls: "podvoice-settings-rules" });
    const toggleKeys = ["stripMarkdown", "removeFrontmatter", "removeTags", "removeLinks", "removeUrls", "removeEmbeds", "removeHtmlComments", "optimizeAcronyms", "optimizeHyphens", "addPauseAtLineBreaks"] as const;
    for (const key of toggleKeys) {
      this.toggleSetting(rules, this.t(`${key}Name`), this.t(`${key}Desc`), key, key === "addPauseAtLineBreaks");
    }
    if (s.addPauseAtLineBreaks) {
      this.selectSetting(rules, this.t("lineBreakPauseTypeName"), "", "lineBreakPauseType", [["period", this.t("lineBreakPausePeriod")], ["comma", this.t("lineBreakPauseComma")]]);
    }
    this.toggleSetting(rules, this.t("addSpaceAfterPunctuationName"), this.t("addSpaceAfterPunctuationDesc"), "addSpaceAfterPunctuation");
    this.textAreaSetting(rules, this.t("skipLinePatternsName"), this.t("skipLinePatternsDesc"), "skipLinePatterns");
  }

  private textSetting(parent: HTMLElement, name: string, desc: string, key: keyof NoteTtsSettings, secret = false, renderOnBlur = false) {
    new Setting(parent).setName(name).setDesc(desc).addText(text => {
      if (secret) text.inputEl.type = "password";
      let changed = false;
      text.setValue(String(this.plugin.settings[key] ?? "")).onChange(async value => {
        (this.plugin.settings[key] as string) = value;
        changed = true;
        await this.plugin.saveSettings();
      });
      if (renderOnBlur) text.inputEl.addEventListener("blur", () => { if (changed) this.renderSettings(); });
    });
  }

  private textAreaSetting(parent: HTMLElement, name: string, desc: string, key: keyof NoteTtsSettings) {
    new Setting(parent).setName(name).setDesc(desc).addTextArea(text => text
      .setValue(String(this.plugin.settings[key] ?? "")).onChange(async value => {
        (this.plugin.settings[key] as string) = value;
        await this.plugin.saveSettings();
      }));
  }

  private numberSetting(parent: HTMLElement, name: string, desc: string, key: keyof NoteTtsSettings, min?: number, max?: number) {
    new Setting(parent).setName(name).setDesc(desc).addText(text => {
      text.inputEl.type = "number";
      text.inputEl.step = "any";
      if (min !== undefined) text.inputEl.min = String(min);
      if (max !== undefined) text.inputEl.max = String(max);
      text.setValue(String(this.plugin.settings[key] ?? "")).onChange(async value => {
        const number = Number(value);
        if (!value.trim() || !Number.isFinite(number) || (min !== undefined && number < min) || (max !== undefined && number > max)) {
          text.inputEl.setCustomValidity(this.label("请输入有效范围内的数字。", "Enter a number within the allowed range."));
          return;
        }
        text.inputEl.setCustomValidity("");
        (this.plugin.settings[key] as number) = number;
        await this.plugin.saveSettings();
      });
    });
  }

  private sliderSetting(parent: HTMLElement, name: string, desc: string, key: keyof NoteTtsSettings, min: number, max: number, step: number) {
    // Keep imported values outside the usual slider range visible and unchanged.
    const value = Number(this.plugin.settings[key]);
    if (value < min || value > max || !Number.isFinite(value)) {
      this.numberSetting(parent, name, desc, key);
      return;
    }
    new Setting(parent).setName(name).setDesc(desc).addSlider(slider => slider.setLimits(min, max, step)
      .setValue(value).setDynamicTooltip().onChange(async next => {
        (this.plugin.settings[key] as number) = next;
        await this.plugin.saveSettings();
      }));
  }

  private toggleSetting(parent: HTMLElement, name: string, desc: string, key: keyof NoteTtsSettings, rerender = false) {
    new Setting(parent).setName(name).setDesc(desc).addToggle(toggle => toggle
      .setValue(Boolean(this.plugin.settings[key])).onChange(async value => {
        (this.plugin.settings[key] as boolean) = value;
        await this.plugin.saveSettings();
        if (["showPodcastCard", "showTitleInlineButton"].includes(key)) this.plugin.refreshAllInlineButtons();
        if (rerender) this.renderSettings();
      }));
  }

  private selectSetting(parent: HTMLElement, name: string, desc: string, key: keyof NoteTtsSettings, options: string[][], rerender = false, numeric = false) {
    new Setting(parent).setName(name).setDesc(desc).addDropdown(dropdown => {
      const value = String(this.plugin.settings[key] ?? "");
      for (const [id, label] of options) dropdown.addOption(id, label);
      // A custom/legacy value must never silently appear as a different selection.
      if (!options.some(([id]) => id === value)) dropdown.addOption(value, this.label(`当前值：${value}`, `Current: ${value}`));
      dropdown.setValue(value).onChange(async next => {
        Object.assign(this.plugin.settings, { [key]: numeric ? Number(next) : next });
        await this.plugin.saveSettings();
        if (key === "titleButtonPosition") this.plugin.refreshAllInlineButtons();
        if (rerender) this.renderSettings();
      });
    });
  }
}

function renderJsonTemplate(template: string, text: string) {
  const rendered = template.replace(/{{text}}/g, escapeJsonStringContent(text));
  try {
    const value: unknown = JSON.parse(rendered);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模板必须返回 JSON 对象。");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`JSON 模板无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
}

function escapeJsonStringContent(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function hexToArrayBuffer(hex: string) {
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes.buffer;
}

function base64ToArrayBuffer(base64: string) {
  const clean = base64.includes(",") ? base64.split(",", 2)[1] : base64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function findFirstUrl(value: unknown): string | null {
  if (typeof value === "string") {
    return value.startsWith("http") || value.startsWith("data:") ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstUrl(item);
      if (found) return found;
    }
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findFirstUrl(item);
      if (found) return found;
    }
  }
  return null;
}

function renderHeaderTemplate(template: string, text: string): Record<string, string> {
  const value = renderJsonTemplate(template, text);
  const headers: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new Error("请求头的值必须是字符串。");
    headers[key] = item;
  }
  return headers;
}

function getByPath(value: unknown, path: string): unknown {
  if (!path) return undefined;
  return path.split(".").reduce<unknown>((current, key) =>
    current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, value);
}

function looksLikeJson(contentType: string | undefined) {
  return Boolean(contentType?.toLowerCase().includes("json"));
}

function getHeader(headers: Record<string, string> | undefined, name: string) {
  if (!headers) return undefined;
  const direct = headers[name];
  if (direct) return direct;
  const lowerName = name.toLowerCase();
  const key = Object.keys(headers).find((header) => header.toLowerCase() === lowerName);
  return key ? headers[key] : undefined;
}

function looksLikeWav(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer.slice(0, 12));
  return readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "WAVE";
}

function audioHeader(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer.slice(0, 12));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function extensionFromMime(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("flac")) return "flac";
  if (normalized.includes("mp4") || normalized.includes("m4a") || normalized.includes("aac")) return "m4a";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  return "mp3";
}

function extensionFromPath(path: string) {
  const match = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "mp3";
}

function mimeFromExtension(extension: string) {
  const normalized = extension.toLowerCase();
  if (normalized === "m4a" || normalized === "mp4" || normalized === "aac") return "audio/mp4";
  if (normalized === "wav") return "audio/wav";
  if (normalized === "flac") return "audio/flac";
  return "audio/mpeg";
}

function numericValue(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

async function requestUrlWithRetries(
  options: Parameters<typeof requestUrl>[0],
  config: {
    attempts?: number;
    baseDelayMs?: number;
    errorPrefix?: string;
    onRetry?: (attempt: number, error: unknown) => void;
  } = {}
) {
  const attempts = Math.max(1, config.attempts || 4);
  const baseDelayMs = config.baseDelayMs || 1500;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await requestUrl(options);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        break;
      }
      config.onRetry?.(attempt, error);
      await sleep(baseDelayMs * attempt);
    }
  }

  const prefix = config.errorPrefix || "HTTP 请求失败";
  throw new Error(`${prefix}：${errorMessage(lastError)}`);
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const err = error as { json?: unknown; text?: unknown; message?: unknown };
    const message = typeof err.message === "string" ? err.message : "";
    let detail = "";
    const bodyDetail = (body: unknown, fallback: string): string => {
      if (!body || typeof body !== "object") return fallback;
      const value = body as Record<string, unknown>;
      if (typeof value.message === "string") return value.message;
      if (typeof value.error === "string") return value.error;
      return fallback;
    };
    if (err.json && typeof err.json === "object") {
      detail = bodyDetail(err.json, JSON.stringify(err.json));
    } else if (typeof err.text === "string" && err.text.trim()) {
      try { detail = bodyDetail(JSON.parse(err.text) as unknown, err.text); }
      catch { detail = err.text; }
    }
    if (detail) return `${message || "请求失败"}：${detail}`;
    if (message) return message;
  }
  return error instanceof Error ? error.message : String(error);
}

// Local playback must follow paragraph boundaries, not fill a 1200-character request.
// Limits are soft: keep an unbroken sentence/word rather than cut through its pronunciation.
function splitLocalNarration(text: string, configuredLimit: number): string[] {
  const output: string[] = [];
  const laterLimit = Math.max(80, Math.min(160, configuredLimit));
  const limit = () => output.length ? laterLimit : Math.min(80, laterLimit);
  const splitAt = (value: string, boundary: RegExp): string[] => {
    const parts: string[] = [];
    let offset = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(value))) {
      const end = match.index + match[0].length;
      parts.push(value.slice(offset, end));
      offset = end;
    }
    if (offset < value.length) parts.push(value.slice(offset));
    return parts;
  };
  for (const paragraph of text.split(/\r?\n+/).map(value => value.trim()).filter(Boolean)) {
    let current = "";
    const add = (part: string) => {
      if (current && (current + part).trim().length > limit()) {
        output.push(current.trim());
        current = "";
      }
      current += part;
    };
    const sentences = splitAt(paragraph, /[。！？!?]+[”’"'）)】》]*|\.[”’"'）)】》]*(?=\s|$)/g);
    for (const sentence of sentences) {
      if (sentence.trim().length > limit()) {
        // Only clause punctuation; avoid decimal points, digit grouping and clock colons.
        for (const clause of splitAt(sentence, /[，,；;：:](?!\d)[”’"'）)】》]*/g)) add(clause);
      } else add(sentence);
    }
    if (current.trim()) output.push(current.trim()); // Never merge distinct paragraphs.
  }
  return output.length ? output : [text];
}

function splitTextForTts(text: string, maxCharacters: number): string[] {
  const normalized = text.replace(/[ \t]+/g, " ").trim();
  if (normalized.length <= maxCharacters) {
    return [normalized];
  }

  function splitChunks(chunks: string[], level: number): string[] {
    const result: string[] = [];
    for (const chunk of chunks) {
      if (chunk.length <= maxCharacters) {
        result.push(chunk);
        continue;
      }

      let subChunks: string[] = [];
      if (level === 0) {
        subChunks = chunk.split(/\n\n+/).map(s => s.trim()).filter(Boolean);
      } else if (level === 1) {
        subChunks = chunk.split(/\n+/).map(s => s.trim()).filter(Boolean);
      } else if (level === 2) {
        const parts = chunk.split(/([。！？!?]|\.\s+|\.$)/g);
        for (let i = 0; i < parts.length; i += 2) {
          const segment = parts[i];
          const delimiter = parts[i + 1] || "";
          const combined = (segment + delimiter).trim();
          if (combined) {
            subChunks.push(combined);
          }
        }
      } else if (level === 3) {
        const parts = chunk.split(/([；;，、：:]|,\s+|,$)/g);
        for (let i = 0; i < parts.length; i += 2) {
          const segment = parts[i];
          const delimiter = parts[i + 1] || "";
          const combined = (segment + delimiter).trim();
          if (combined) {
            subChunks.push(combined);
          }
        }
      } else if (level === 4) {
        const parts = chunk.split(/(\s+)/g);
        for (let i = 0; i < parts.length; i += 2) {
          const segment = parts[i];
          const delimiter = parts[i + 1] || "";
          const combined = (segment + delimiter).trim();
          if (combined) {
            subChunks.push(combined);
          }
        }
      } else {
        subChunks = hardSplitText(chunk, maxCharacters);
      }

      if (subChunks.length > 1 || level === 5) {
        result.push(...splitChunks(subChunks, level + 1));
      } else {
        result.push(...splitChunks([chunk], level + 1));
      }
    }
    return result;
  }

  const finalChunks = splitChunks([normalized], 0);

  const groupedChunks: string[] = [];
  let currentChunk = "";

  for (const chunk of finalChunks) {
    if (!currentChunk) {
      currentChunk = chunk;
    } else {
      const separator = currentChunk.endsWith("\n") || chunk.startsWith("\n") ? "\n" : " ";
      const candidate = currentChunk + separator + chunk;
      if (candidate.length <= maxCharacters) {
        currentChunk = candidate;
      } else {
        groupedChunks.push(currentChunk);
        currentChunk = chunk;
      }
    }
  }
  if (currentChunk) {
    groupedChunks.push(currentChunk);
  }

  return groupedChunks
    .map((c) => c.trim())
    .filter((c) => Boolean(c) && /[\p{L}\p{N}]/u.test(c));
}

function hardSplitText(text: string, maxCharacters: number) {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxCharacters) {
    chunks.push(text.slice(index, index + maxCharacters));
  }
  return chunks;
}

function combineAudioResults(audios: AudioResult[], providerName: string, gapSeconds = 0): AudioResult {
  if (!audios.length) {
    throw new Error(`${providerName} 没有返回可合并的音频。`);
  }
  if (audios.length === 1) {
    return audios[0];
  }
  if (audios.some((audio) => !audio.data)) {
    throw new Error(`${providerName} 返回了已保存文件，无法继续合并分段音频。`);
  }
  const audioData = audios.map((audio) => audio.data as ArrayBuffer);

  if (audios.every((audio, index) => audio.mimeType.toLowerCase().includes("wav") || looksLikeWav(audioData[index]))) {
    return {
      data: concatenateWavs(audioData, gapSeconds),
      extension: "wav",
      mimeType: "audio/wav",
    };
  }

  if (audios.every((audio) => isMp3Audio(audio))) {
    return {
      data: concatenateArrayBuffers(audioData),
      extension: "mp3",
      mimeType: "audio/mpeg",
    };
  }

  const details = audios
    .map((audio, index) => `${index + 1}:${audio.mimeType || "unknown"}:${audio.data ? audioHeader(audio.data) : "no-data"}`)
    .join(", ");
  throw new Error(`${providerName} 分段音频格式不一致，无法合并。收到：${details}`);
}

function isMp3Audio(audio: AudioResult) {
  const mimeType = audio.mimeType.toLowerCase();
  return audio.extension.toLowerCase() === "mp3" || mimeType.includes("mpeg") || mimeType.includes("mp3");
}

function concatenateArrayBuffers(buffers: ArrayBuffer[]) {
  const byteLength = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const buffer of buffers) {
    output.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return output.buffer;
}

function concatenateWavs(buffers: ArrayBuffer[], gapSeconds = 0) {
  if (!buffers.length) {
    throw new Error("没有可合并的 WAV 音频。");
  }

  const chunks = buffers.map(parseWav);
  const first = chunks[0];
  const compatible = chunks.every((chunk) =>
    chunk.audioFormat === first.audioFormat &&
    chunk.channels === first.channels &&
    chunk.sampleRate === first.sampleRate &&
    chunk.bitsPerSample === first.bitsPerSample
  );
  if (!compatible) {
    throw new Error("WAV 分段格式不一致，无法合并。");
  }

  const gapBytes = Math.round(first.sampleRate * gapSeconds) * first.blockAlign;
  const dataSize = chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0) + gapBytes * (chunks.length - 1);
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);
  const bytes = new Uint8Array(output);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, first.audioFormat, true);
  view.setUint16(22, first.channels, true);
  view.setUint32(24, first.sampleRate, true);
  view.setUint32(28, first.byteRate, true);
  view.setUint16(32, first.blockAlign, true);
  view.setUint16(34, first.bitsPerSample, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const [index, chunk] of chunks.entries()) {
    bytes.set(new Uint8Array(chunk.data), offset);
    offset += chunk.data.byteLength;
    if (index < chunks.length - 1) {
      // 8-bit PCM is unsigned: silence is 128, not zero.
      if (first.audioFormat === 1 && first.bitsPerSample === 8) bytes.fill(128, offset, offset + gapBytes);
      offset += gapBytes;
    }
  }
  return output;
}

function parseWav(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") {
    throw new Error("Custom 分段响应不是有效 WAV。");
  }

  let offset = 12;
  let fmt: {
    audioFormat: number;
    channels: number;
    sampleRate: number;
    byteRate: number;
    blockAlign: number;
    bitsPerSample: number;
  } | null = null;
  let data: ArrayBuffer | null = null;

  while (offset + 8 <= buffer.byteLength) {
    const id = readAscii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        byteRate: view.getUint32(start + 8, true),
        blockAlign: view.getUint16(start + 12, true),
        bitsPerSample: view.getUint16(start + 14, true),
      };
    } else if (id === "data") {
      data = buffer.slice(start, start + size);
      break;
    }
    offset = start + size + (size % 2);
  }

  if (!fmt || !data) {
    throw new Error("WAV 缺少 fmt 或 data chunk。");
  }
  return { ...fmt, data };
}

function readAscii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function writeAscii(bytes: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index++) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

// A duration is a quantity; keep four-digit calendar years and identifiers intact.
function verbalizeYearDurations(text: string): string {
  const digits = "零一二三四五六七八九";
  const numberWord = (value: number): string => {
    if (value < 10) return digits.charAt(value);
    if (value < 100) return (value < 20 ? "" : digits.charAt(Math.floor(value / 10))) + "十" + (value % 10 ? digits.charAt(value % 10) : "");
    const rest = value % 100;
    return digits.charAt(Math.floor(value / 100)) + "百" + (rest ? (rest < 10 ? "零" : rest < 20 ? "一" : "") + numberWord(rest) : "");
  };
  return text.replace(/(?<![\d.A-Za-z])([1-9]\d{0,2})[ \t]*年(?=前|后|以[前后]|之[前后])/g,
    (_match, value: string) => numberWord(Number(value)) + "年");
}

// Prefer leaving an ambiguous value untouched over reading a ratio or media offset as a clock.
function verbalizeExplicitClockTimes(text: string): string {
  const excludedContext = /比例|配比|比率|比值|宽高比|纵横比|比分|得分|战成|打成|领先|落后|视频|音频|播客|录音|录像|字幕|时间码|时间戳|进度|跳转|跳到|播放到|播放至|时间轴|时长|用时|耗时|计时/;
  const clockCue = /(?:今天|明天|后天|昨天|今早|今晨|今晚|明早|明晚|上午|下午|中午|早上|早晨|凌晨|清晨|傍晚|晚上|北京时间|当地时间|开会时间|会议时间|开始时间|结束时间|出发时间|到达时间|集合时间|闹钟)(?:\s*(?:设为|设在|设置为|定于|定在|安排在|约在|于|在|从|到|至|是|为|约|的))*\s*[:：]?\s*$/;
  const eventCue = /(?:会议|讲座|课程|活动|直播|航班|列车|开会|开场|开播|开课|上课|下课|出发|到达|集合)(?:\s*(?:将|会))?\s*(?:于|在|从|定于|定在|安排在|开始于)\s*$/;
  const numberWord = (value: number): string => {
    const digits = "零一二三四五六七八九";
    if (value < 10) return digits.charAt(value);
    return (value < 20 ? "" : digits.charAt(Math.floor(value / 10))) + "十" + (value % 10 ? digits.charAt(value % 10) : "");
  };
  return text.replace(/([01]?\d|2[0-3])[:：]([0-5]\d)/g,
    (match: string, hourText: string, minuteText: string, offset: number, source: string) => {
      const before = source.slice(0, offset);
      const after = source.slice(offset + match.length);
      // No partial matches in identifiers, HH:MM:SS, or fractional-second timecodes.
      if (/[\w.]$/.test(before) || /^[\w]/.test(after) || /\d\s*[:：]\s*$/.test(before) || /^\s*[:：]\s*\d/.test(after) || /^[.,]\d/.test(after)) return match;
      const left = before.split(/[。！？!?；;\n]/).pop() || "";
      const right = after.split(/[。！？!?；;\n]/)[0];
      if (excludedContext.test(left + match + right)) return match;
      // A second endpoint may inherit the explicit clock cue of the first endpoint.
      const cue = left.replace(/(?:[01]?\d|2[0-3])[:：][0-5]\d\s*(?:到|至|[-–—~～])\s*$/, "");
      if (!clockCue.test(cue) && !eventCue.test(cue)) return match;
      const hour = Number(hourText);
      const minute = Number(minuteText);
      const spokenHour = hour === 2 ? "两" : numberWord(hour);
      const spokenMinute = minute === 0 ? "整" : minute === 30 ? "半" : (minute < 10 ? "零" : "") + numberWord(minute) + "分";
      return `${spokenHour}点${spokenMinute}`;
    });
}

function normalizeFolder(folder: string) {
  return (folder || DEFAULT_SETTINGS.outputFolder).replace(/^\/+|\/+$/g, "");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function clampNumber(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

async function ensureFolder(app: App, folder: string) {
  const parts = folder.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
