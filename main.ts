import {
  addIcon,
  App,
  Editor,
  Menu,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TFile,
} from "obsidian";

type ProviderId = "minimax" | "replicate" | "custom";
type SettingsLanguage = "auto" | "zh" | "en";

const REPLICATE_MINIMAX_MODEL = "minimax/speech-2.8-turbo";
const REPLICATE_CUSTOM_VOICE = "custom";
const NOTE_TTS_NOTE_ICON = "note-tts-note";
const NOTE_TTS_SELECTION_ICON = "note-tts-selection";
const NOTE_TTS_PREVIEW_ICON = "note-tts-preview";

const NOTE_TTS_NOTE_ICON_SVG = `
<rect x="16" y="10" width="46" height="80" rx="8" fill="none" stroke="currentColor" stroke-width="9"/>
<path d="M29 34h20M29 52h16M29 70h13" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round"/>
<path d="M68 38v40l28-20z" fill="currentColor"/>
`;

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

interface NoteTtsSettings {
  settingsLanguage: SettingsLanguage;
  provider: ProviderId;
  outputFolder: string;
  maxCharacters: number;
  chunkCharacters: number;
  stripMarkdown: boolean;
  removeFrontmatter: boolean;
  removeTags: boolean;
  removeLinks: boolean;
  removeUrls: boolean;
  removeEmbeds: boolean;
  removeHtmlComments: boolean;
  skipLinePatterns: string;
  optimizeAcronyms: boolean;
  addPauseAtLineBreaks: boolean;
  lineBreakPauseType: "period" | "comma";
  addSpaceAfterPunctuation: boolean;
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
}

const DEFAULT_SETTINGS: NoteTtsSettings = {
  settingsLanguage: "auto",
  provider: "minimax",
  outputFolder: "TTS Audio",
  maxCharacters: 10000,
  chunkCharacters: 1200,
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
};

interface AudioResult {
  data?: ArrayBuffer;
  extension: string;
  mimeType: string;
  vaultPath?: string;
}

interface PendingTtsTask {
  id: string;
  sourcePath: string;
  statusUrl: string;
  audioUrl?: string;
  headers: Record<string, string>;
  created: number;
  textLength: number;
}

class PendingTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingTaskError";
  }
}

type SettingsTextKey =
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
  | "optimizeAcronymsName"
  | "optimizeAcronymsDesc"
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
  | "customAudioBase64PathDesc";

const SETTINGS_TEXT: Record<"zh" | "en", Record<SettingsTextKey, string>> = {
  zh: {
    settingsLanguageName: "设置页语言",
    settingsLanguageDesc: "选择此插件设置页使用的语言。Auto 默认显示英文，中文可手动选择。",
    settingsLanguageAuto: "Auto（默认 English）",
    settingsLanguageZh: "中文",
    settingsLanguageEn: "English",
    providerDesc: "选择用哪个 API 生成语音。",
    outputFolderName: "输出文件夹",
    outputFolderDesc: "生成的 MP3 会保存到 vault 中的这个文件夹。",
    maxCharactersName: "最大字符数",
    maxCharactersDesc: "避免把特别长的笔记误发给同步 API。",
    chunkCharactersName: "分段字符数",
    chunkCharactersDesc: "大于 0 时，长文本会分段生成再合并，手机端建议 800-1500；填 0 可关闭分段。",
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
    optimizeAcronymsName: "优化英文缩写朗读",
    optimizeAcronymsDesc: "在连续大写字母（如 SDK、API）之间自动插入空格，防止被读成单个单词或连读。",
    addPauseAtLineBreaksName: "行尾自动添加停顿",
    addPauseAtLineBreaksDesc: "如果行尾没有标点符号（如标题、列表项），自动添加停顿符号，避免朗读时与下一行内容连在一起。",
    lineBreakPauseTypeName: "行尾停顿符号",
    lineBreakPauseTypeDesc: "选择在没有标点符号的行尾添加句号（停顿较长）还是逗号（停顿较短）。",
    lineBreakPausePeriod: "句号 。",
    lineBreakPauseComma: "逗号 ，",
    addSpaceAfterPunctuationName: "标点符号后添加空格",
    addSpaceAfterPunctuationDesc: "在所有标点符号（如逗号、句号、分号、问号、感叹号、冒号、顿号等）后自动加上空格，帮助 TTS 语音在标点处发出更自然的短停顿。",
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
  },
  en: {
    settingsLanguageName: "Settings language",
    settingsLanguageDesc: "Choose the language used on this plugin settings page. Auto defaults to English; Chinese can be selected manually.",
    settingsLanguageAuto: "Auto (English default)",
    settingsLanguageZh: "Chinese",
    settingsLanguageEn: "English",
    providerDesc: "Choose which API provider generates speech.",
    outputFolderName: "Output folder",
    outputFolderDesc: "Generated MP3 files are saved to this folder inside your vault.",
    maxCharactersName: "Maximum characters",
    maxCharactersDesc: "Prevents accidentally sending very long notes to a synchronous API.",
    chunkCharactersName: "Chunk characters",
    chunkCharactersDesc: "When greater than 0, long text is generated in chunks and merged. Recommended on mobile: 800-1500. Use 0 to disable chunking.",
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
    optimizeAcronymsName: "Optimize English acronyms",
    optimizeAcronymsDesc: "Automatically inserts spaces between consecutive uppercase letters, such as SDK and API, so they are not read as a single word or run together.",
    addPauseAtLineBreaksName: "Add pauses at line ends",
    addPauseAtLineBreaksDesc: "If a line ends without punctuation, such as headings or list items, add a pause mark so it does not run into the next line.",
    lineBreakPauseTypeName: "Line-end pause mark",
    lineBreakPauseTypeDesc: "Choose whether lines without punctuation end with a period for a longer pause or a comma for a shorter pause.",
    lineBreakPausePeriod: "Period .",
    lineBreakPauseComma: "Comma ,",
    addSpaceAfterPunctuationName: "Add spaces after punctuation",
    addSpaceAfterPunctuationDesc: "Adds a space after punctuation marks, such as commas, periods, semicolons, question marks, exclamation marks, colons, and Chinese enumeration commas, to help TTS produce more natural short pauses.",
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
  },
};

function getSettingsDisplayLanguage(selected: SettingsLanguage): "zh" | "en" {
  if (selected === "zh" || selected === "en") {
    return selected;
  }
  return "en";
}

export default class NoteTtsPlugin extends Plugin {
  settings: NoteTtsSettings;
  pendingTasks: PendingTtsTask[] = [];

  async onload() {
    await this.loadSettings();
    this.registerIcons();

    this.addRibbonIcon(NOTE_TTS_NOTE_ICON, "Convert current note to speech", async () => {
      await this.synthesizeActiveView("note");
    });

    this.addCommand({
      id: "synthesize-current-note",
      name: "Convert current note to speech",
      icon: NOTE_TTS_NOTE_ICON,
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        await this.synthesize(view, "note", editor);
      },
    });

    this.addCommand({
      id: "synthesize-selection",
      name: "Convert selected text to speech",
      icon: NOTE_TTS_SELECTION_ICON,
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        await this.synthesize(view, "selection", editor);
      },
    });

    this.addCommand({
      id: "preview-cleaned-text",
      name: "Preview cleaned text for speech",
      icon: NOTE_TTS_PREVIEW_ICON,
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        const sourceText = await this.getTextForMode(view, editor.getSelection() ? "selection" : "note", editor);
        new CleanedTextPreviewModal(this.app, this.prepareText(sourceText)).open();
      },
    });

    this.addCommand({
      id: "check-pending-tts-tasks",
      name: "Check pending speech tasks",
      icon: NOTE_TTS_NOTE_ICON,
      callback: async () => {
        await this.checkPendingTasks();
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view: MarkdownView) => {
        menu.addItem((item) => {
          item
            .setTitle("Convert current note to speech")
            .setIcon(NOTE_TTS_NOTE_ICON)
            .onClick(async () => {
              await this.synthesize(view, "note", editor);
            });
        });
        menu.addItem((item) => {
          item
            .setTitle("Convert selected text to speech")
            .setIcon(NOTE_TTS_SELECTION_ICON)
            .onClick(async () => {
              await this.synthesize(view, "selection", editor);
            });
        });
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") {
          return;
        }

        menu.addItem((item) => {
          item
            .setTitle("Convert note to speech")
            .setIcon(NOTE_TTS_NOTE_ICON)
            .onClick(async () => {
              await this.synthesizeFile(file);
            });
        });
      })
    );

    this.addSettingTab(new NoteTtsSettingTab(this.app, this));
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.pendingTasks = Array.isArray(data?.pendingTasks) ? data.pendingTasks : [];
  }

  async saveSettings() {
    await this.saveData({ ...this.settings, pendingTasks: this.pendingTasks });
  }

  private registerIcons() {
    addIcon(NOTE_TTS_NOTE_ICON, NOTE_TTS_NOTE_ICON_SVG);
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

  private async synthesizeFile(file: TFile) {
    const status = new TtsStatusModal(this.app);
    status.open();
    status.setStatus("正在读取笔记...");

    const text = this.prepareText(await this.app.vault.read(file));
    if (!text.trim()) {
      status.close();
      new Notice("没有可转换的笔记内容。");
      return;
    }

    if (text.length > this.settings.maxCharacters) {
      status.close();
      new Notice(`文本超过 ${this.settings.maxCharacters} 字符，请先选中较短片段。`);
      return;
    }

    try {
      status.setStatus("正在请求语音模型...");
      const audio = await this.generateAudio(text, status, file);
      status.setStatus("正在保存音频文件...");
      const saved = await this.saveAudioFile(file, audio);
      status.setStatus("语音已生成。");
      status.close();
      new Notice("语音已生成。");
      new AudioResultModal(this.app, saved).open();
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
    }
  }

  private async synthesize(view: MarkdownView, mode: "note" | "selection", editor?: Editor) {
    const status = new TtsStatusModal(this.app);
    status.open();
    status.setStatus(mode === "selection" ? "正在读取选中文本..." : "正在读取当前笔记...");

    const sourceText = await this.getTextForMode(view, mode, editor);
    const text = this.prepareText(sourceText);
    if (!text.trim()) {
      status.close();
      new Notice(mode === "selection" ? "请先选择要转换的文本。" : "没有可转换的笔记内容。");
      return;
    }

    if (text.length > this.settings.maxCharacters) {
      status.close();
      new Notice(`文本超过 ${this.settings.maxCharacters} 字符，请先选中较短片段。`);
      return;
    }

    const activeFile = view.file;
    if (!activeFile) {
      status.close();
      new Notice("没有找到当前笔记文件。");
      return;
    }

    try {
      status.setStatus("正在请求语音模型...");
      const audio = await this.generateAudio(text, status, activeFile);
      status.setStatus("正在保存音频文件...");
      const saved = await this.saveAudioFile(activeFile, audio);
      status.setStatus("语音已生成。");
      status.close();
      new Notice("语音已生成。");
      new AudioResultModal(this.app, saved).open();
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

  private prepareText(text: string) {
    let normalized = text.replace(/\r\n/g, "\n").trim();
    if (this.settings.removeFrontmatter) {
      normalized = normalized.replace(/^---\n[\s\S]*?\n---\n?/, "");
    }
    if (this.settings.removeHtmlComments) {
      normalized = normalized.replace(/<!--[\s\S]*?-->/g, "");
    }
    if (this.settings.removeEmbeds) {
      normalized = normalized
        .replace(/!\[[^\]]*]\([^)]*\)/g, "")
        .replace(/!\[\[[^\]]+]]/g, "");
    }
    if (this.settings.removeLinks) {
      normalized = normalized
        .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
        .replace(/\[\[([^|\]]+)\|([^\]]+)]]/g, "$2")
        .replace(/\[\[([^\]]+)]]/g, "$1");
    }
    if (this.settings.removeUrls) {
      normalized = normalized.replace(/https?:\/\/\S+|www\.\S+/g, "");
    }
    if (this.settings.removeTags) {
      normalized = normalized
        .replace(/(^|\s)#[\p{L}\p{N}_/-]+/gu, "$1")
        .replace(/^\s*tags:\s*\[[^\]]*]\s*$/gim, "")
        .replace(/^\s*tags:\s*.*$/gim, "");
    }

    normalized = this.removeSkippedLines(normalized);

    let cleaned = normalized;
    if (this.settings.stripMarkdown) {
      cleaned = normalized
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/^\s*\d+\.\s+/gm, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/_([^_]+)_/g, "$1")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    if (this.settings.addPauseAtLineBreaks) {
      const pauseChar = this.settings.lineBreakPauseType === "comma" ? "，" : "。";
      const punctuationRegex = /[。！？，；：、”’）〕】〉》.!?,;:"')\]>]$/;
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

    if (this.settings.optimizeAcronyms) {
      cleaned = cleaned.replace(/\b[A-Z]{2,}\b/g, (match) => {
        return match.split("").join(" ");
      });
    }

    if (this.settings.addSpaceAfterPunctuation) {
      cleaned = cleaned.replace(/([。！？，；：、.!?,;:])(?![ \t\n\r])/g, "$1 ");
    }

    return cleaned;
  }

  private removeSkippedLines(text: string) {
    const patterns = this.settings.skipLinePatterns
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

  private async generateAudio(text: string, status?: TtsStatusModal, sourceFile?: TFile): Promise<AudioResult> {
    if (this.settings.provider === "minimax") {
      return this.generateWithMiniMax(text, status);
    }
    if (this.settings.provider === "replicate") {
      return this.generateWithReplicate(text, status);
    }
    return this.generateWithCustomProvider(text, status, sourceFile);
  }

  private async generateWithMiniMax(text: string, status?: TtsStatusModal): Promise<AudioResult> {
    if (!this.settings.minimaxApiKey) {
      throw new Error("请先在设置里填写 MiniMax API Key。");
    }

    const chunkCharacters = Number(this.settings.chunkCharacters) || 0;
    if (chunkCharacters > 0 && text.length > chunkCharacters) {
      return this.generateWithMiniMaxChunks(text, chunkCharacters, status);
    }

    return this.requestMiniMaxAudio(text);
  }

  private async generateWithMiniMaxChunks(text: string, chunkCharacters: number, status?: TtsStatusModal): Promise<AudioResult> {
    const chunks = splitTextForTts(text, Math.max(80, chunkCharacters));
    if (chunks.length <= 1) {
      return this.requestMiniMaxAudio(text);
    }

    const audios: AudioResult[] = [];
    for (let index = 0; index < chunks.length; index++) {
      status?.setStatus(`MiniMax 正在生成分段 ${index + 1}/${chunks.length}...`);
      audios.push(await this.requestMiniMaxAudio(chunks[index]));
    }

    return combineAudioResults(audios, "MiniMax");
  }

  private async requestMiniMaxAudio(text: string): Promise<AudioResult> {
    const response = await requestUrl({
      url: this.settings.minimaxEndpoint,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.minimaxApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.settings.minimaxModel,
        text,
        stream: false,
        output_format: "hex",
        language_boost: this.settings.minimaxLanguageBoost || "auto",
        voice_setting: {
          voice_id: this.settings.minimaxVoiceId,
          speed: Math.round(this.settings.minimaxSpeed),
          vol: Math.round(this.settings.minimaxVolume),
          pitch: Math.round(this.settings.minimaxPitch),
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: "mp3",
          channel: 1,
        },
      }),
    });

    const payload = response.json;
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

  private async generateWithReplicate(text: string, status?: TtsStatusModal): Promise<AudioResult> {
    if (!this.settings.replicateApiToken) {
      throw new Error("请先在设置里填写 Replicate API Token。");
    }

    const chunkCharacters = Number(this.settings.chunkCharacters) || 0;
    if (chunkCharacters > 0 && text.length > chunkCharacters) {
      return this.generateWithReplicateChunks(text, chunkCharacters, status);
    }

    return this.requestReplicateAudio(text, status);
  }

  private async generateWithReplicateChunks(text: string, chunkCharacters: number, status?: TtsStatusModal): Promise<AudioResult> {
    const chunks = splitTextForTts(text, Math.max(80, chunkCharacters));
    if (chunks.length <= 1) {
      return this.requestReplicateAudio(text, status);
    }

    const audios: AudioResult[] = [];
    for (let index = 0; index < chunks.length; index++) {
      status?.setStatus(`Replicate 正在生成分段 ${index + 1}/${chunks.length}...`);
      audios.push(await this.requestReplicateAudio(chunks[index], status));
    }

    return combineAudioResults(audios, "Replicate");
  }

  private async requestReplicateAudio(text: string, status?: TtsStatusModal): Promise<AudioResult> {
    const model = this.settings.replicateModel || REPLICATE_MINIMAX_MODEL;
    const input = this.createReplicateInput(text, model);
    const url = this.createReplicatePredictionUrl(model);
    const body = model === REPLICATE_MINIMAX_MODEL
      ? { input }
      : { version: this.settings.replicateVersion, input };

    if (model !== REPLICATE_MINIMAX_MODEL && !this.settings.replicateVersion) {
      throw new Error("请先在设置里填写 Replicate 模型 version。");
    }

    status?.setStatus("正在提交 Replicate 任务...");
    let prediction = await this.requestReplicateJson({
      url,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.replicateApiToken}`,
        "Content-Type": "application/json",
        Prefer: "wait=60",
      },
      body: JSON.stringify(body),
    });

    prediction = await this.pollReplicatePrediction(prediction, status);
    const outputUrl = findFirstUrl(prediction?.output);
    if (!outputUrl) {
      throw new Error("Replicate 输出里没有找到音频 URL。");
    }

    status?.setStatus("正在下载音频...");
    return this.downloadAudio(outputUrl);
  }

  private createReplicateInput(text: string, model: string) {
    if (model === REPLICATE_MINIMAX_MODEL) {
      const languageBoost = this.settings.replicateLanguageBoost === "auto"
        ? "None"
        : this.settings.replicateLanguageBoost || "None";
      const voiceId = this.getReplicateMiniMaxVoiceId();

      return {
        text,
        pitch: Number.isFinite(this.settings.replicatePitch) ? this.settings.replicatePitch : 0,
        speed: clampNumber(this.settings.replicateSpeed, 0.5, 2, 1),
        volume: clampNumber(this.settings.replicateVolume, 0, 10, 1),
        bitrate: 128000,
        channel: "mono",
        emotion: this.settings.replicateEmotion || "auto",
        voice_id: voiceId,
        sample_rate: 32000,
        audio_format: "mp3",
        language_boost: languageBoost,
        subtitle_enable: false,
        english_normalization: false,
      };
    }

    return renderJsonTemplate(this.settings.replicateInputTemplate, text);
  }

  private getReplicateMiniMaxVoiceId() {
    if (this.settings.replicateVoiceId === REPLICATE_CUSTOM_VOICE) {
      const customVoiceId = this.settings.replicateCustomVoiceId.trim();
      if (!customVoiceId) {
        throw new Error("请选择一个内置音色，或填写 Custom voice ID。");
      }
      return customVoiceId;
    }

    return REPLICATE_MINIMAX_VOICES.includes(this.settings.replicateVoiceId)
      ? this.settings.replicateVoiceId
      : "Wise_Woman";
  }

  private createReplicatePredictionUrl(model: string) {
    if (model === REPLICATE_MINIMAX_MODEL) {
      return "https://api.replicate.com/v1/models/minimax/speech-2.8-turbo/predictions";
    }

    return "https://api.replicate.com/v1/predictions";
  }

  private async pollReplicatePrediction(prediction: any, status?: TtsStatusModal) {
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
          Authorization: `Bearer ${this.settings.replicateApiToken}`,
        },
      });
    }

    throw new Error("Replicate 生成超时，请稍后重试。");
  }

  private async requestReplicateJson(options: Parameters<typeof requestUrl>[0]) {
    try {
      return (await requestUrl(options)).json;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const body = (error as { response?: { json?: unknown; text?: string } })?.response;
      const detail = body?.json ? JSON.stringify(body.json) : body?.text;
      throw new Error(detail ? `Replicate 请求失败：${detail}` : `Replicate 请求失败：${message}`);
    }
  }

  private async generateWithCustomProvider(text: string, status?: TtsStatusModal, sourceFile?: TFile): Promise<AudioResult> {
    if (!this.settings.customEndpoint) {
      throw new Error("请先填写自定义 Provider Endpoint。");
    }

    const chunkCharacters = Number(this.settings.customChunkCharacters) || 0;
    if (chunkCharacters > 0 && text.length > chunkCharacters) {
      return this.generateWithCustomProviderChunks(text, chunkCharacters, status);
    }

    return this.requestCustomProviderAudio(text, status, sourceFile);
  }

  private async generateWithCustomProviderChunks(text: string, chunkCharacters: number, status?: TtsStatusModal): Promise<AudioResult> {
    const chunks = splitTextForTts(text, Math.max(80, chunkCharacters));
    if (chunks.length <= 1) {
      return this.requestCustomProviderAudio(text, status);
    }

    const audios: AudioResult[] = [];
    for (let index = 0; index < chunks.length; index++) {
      status?.setStatus(`正在生成分段 ${index + 1}/${chunks.length}...`);
      audios.push(await this.requestCustomProviderAudio(chunks[index], status));
    }

    return combineAudioResults(audios, "Custom");
  }

  private async requestCustomProviderAudio(text: string, status?: TtsStatusModal, sourceFile?: TFile): Promise<AudioResult> {
    const headers = renderJsonTemplate(this.settings.customHeaders || "{}", text);
    const body = this.settings.customBodyTemplate
      ? JSON.stringify({
          ...renderJsonTemplate(this.settings.customBodyTemplate, text),
          filename: sourceFile?.basename || "Note TTS",
        })
      : undefined;

    status?.setStatus("正在提交本地语音任务...");
    const response = await requestUrlWithRetries(
      {
        url: this.settings.customEndpoint,
        method: this.settings.customMethod || "POST",
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

    const payload = response.json;
    if (payload?.task_id || payload?.status_url) {
      return this.pollCustomProviderTask(payload, headers, status, sourceFile, text.length);
    }

    const audioUrl = getByPath(payload, this.settings.customAudioUrlPath);
    if (typeof audioUrl === "string" && audioUrl) {
      return this.downloadAudio(audioUrl, headers);
    }

    const audioHex = getByPath(payload, this.settings.customAudioHexPath);
    if (typeof audioHex === "string" && audioHex) {
      return {
        data: hexToArrayBuffer(audioHex),
        extension: "mp3",
        mimeType: "audio/mpeg",
      };
    }

    const audioBase64 = getByPath(payload, this.settings.customAudioBase64Path);
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
    payload: any,
    headers: Record<string, string>,
    status?: TtsStatusModal,
    sourceFile?: TFile,
    textLength = 0
  ): Promise<AudioResult> {
    const statusUrl = payload?.status_url;
    if (typeof statusUrl !== "string" || !statusUrl) {
      throw new Error("Custom 异步任务缺少 status_url。");
    }
    const pending = sourceFile
      ? await this.rememberPendingTask(payload, headers, sourceFile, statusUrl, textLength)
      : null;

    let transientFailures = 0;
    for (let attempt = 0; attempt < 240; attempt++) {
      status?.setStatus(`Mac mini 正在生成语音... ${attempt + 1}`);
      await sleep(5000);

      let task: any;
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
        task = response.json;
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
    payload: any,
    headers: Record<string, string>,
    sourceFile: TFile,
    statusUrl: string,
    textLength: number
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
        const payload = response.json;
        if (payload?.status === "failed") {
          this.removePendingTask(task.id);
          console.warn("Pending Note TTS task failed:", payload?.error || task.id);
          continue;
        }
        if (payload?.status !== "succeeded") {
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
        this.removePendingTask(task.id);
        completed += 1;
      } catch (error) {
        console.error(error);
        stillProcessing += 1;
      }
    }

    await this.saveSettings();
    status.close();

    if (completed > 0) {
      new Notice(`已下载 ${completed} 个语音文件。`);
      if (lastSaved) {
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

  private async saveAudioFile(sourceFile: TFile, audio: AudioResult) {
    if (audio.vaultPath) {
      const synced = await this.waitForVaultFile(audio.vaultPath, undefined, 20000);
      if (synced) {
        return synced;
      }
      throw new PendingTaskError(`语音已保存在 Mac mini 的 iCloud：${audio.vaultPath}。手机 iCloud 还没同步到，稍后会出现在 TTS Audio 文件夹。`);
    }

    if (!audio.data) {
      throw new Error("语音结果没有音频数据。");
    }

    const folder = normalizeFolder(this.settings.outputFolder);
    await ensureFolder(this.app, folder);

    const basename = sourceFile.basename.replace(/[\\/:*?"<>|#^[\]]/g, "-").slice(0, 80);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `${folder}/${basename}-${timestamp}.${audio.extension || "mp3"}`;
    return this.app.vault.createBinary(path, audio.data);
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
      text: "请保持 Obsidian 打开，生成完成后会自动弹出播放器。",
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
  private dragCleanup: (() => void) | null = null;

  constructor(app: App, file: TFile) {
    super(app);
    this.file = file;
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("note-tts-draggable-modal");
    contentEl.addClass("note-tts-modal");
    const title = contentEl.createEl("h2", { text: "语音已生成", cls: "note-tts-drag-handle" });
    this.enableDrag(title);
    contentEl.createEl("div", { text: this.file.path, cls: "note-tts-path" });

    const audio = contentEl.createEl("audio", {
      attr: {
        controls: "true",
        src: this.app.vault.getResourcePath(this.file),
      },
    });
    audio.focus();

    const actions = contentEl.createDiv({ cls: "note-tts-actions" });
    new Setting(actions)
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
      );
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

class NoteTtsSettingTab extends PluginSettingTab {
  plugin: NoteTtsPlugin;

  constructor(app: App, plugin: NoteTtsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.renderSettings();
  }

  private renderSettings() {
    const { containerEl } = this;
    containerEl.empty();
    const language = getSettingsDisplayLanguage(this.plugin.settings.settingsLanguage);
    const t = (key: SettingsTextKey) => SETTINGS_TEXT[language][key];

    new Setting(containerEl)
      .setName(t("settingsLanguageName"))
      .setDesc(t("settingsLanguageDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", t("settingsLanguageAuto"))
          .addOption("zh", t("settingsLanguageZh"))
          .addOption("en", t("settingsLanguageEn"))
          .setValue(this.plugin.settings.settingsLanguage)
          .onChange(async (value: SettingsLanguage) => {
            this.plugin.settings.settingsLanguage = value;
            await this.plugin.saveSettings();
            this.renderSettings();
          })
      );

    new Setting(containerEl)
      .setName("Provider")
      .setDesc(t("providerDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("minimax", "MiniMax")
          .addOption("replicate", "Replicate")
          .addOption("custom", "Custom HTTP")
          .setValue(this.plugin.settings.provider)
          .onChange(async (value: ProviderId) => {
            this.plugin.settings.provider = value;
            await this.plugin.saveSettings();
            this.renderSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("outputFolderName"))
      .setDesc(t("outputFolderDesc"))
      .addText((text) =>
        text
          .setPlaceholder("TTS Audio")
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value || DEFAULT_SETTINGS.outputFolder;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("maxCharactersName"))
      .setDesc(t("maxCharactersDesc"))
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxCharacters))
          .onChange(async (value) => {
            this.plugin.settings.maxCharacters = Number(value) || DEFAULT_SETTINGS.maxCharacters;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("chunkCharactersName"))
      .setDesc(t("chunkCharactersDesc"))
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.chunkCharacters ?? DEFAULT_SETTINGS.chunkCharacters))
          .onChange(async (value) => {
            this.plugin.settings.chunkCharacters = Number(value) || 0;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("stripMarkdownName"))
      .setDesc(t("stripMarkdownDesc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.stripMarkdown)
          .onChange(async (value) => {
            this.plugin.settings.stripMarkdown = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("textCleanupHeading"))
      .setHeading();
    this.toggleSetting(containerEl, t("removeFrontmatterName"), t("removeFrontmatterDesc"), "removeFrontmatter");
    this.toggleSetting(containerEl, t("removeTagsName"), t("removeTagsDesc"), "removeTags");
    this.toggleSetting(containerEl, t("removeLinksName"), t("removeLinksDesc"), "removeLinks");
    this.toggleSetting(containerEl, t("removeUrlsName"), t("removeUrlsDesc"), "removeUrls");
    this.toggleSetting(containerEl, t("removeEmbedsName"), t("removeEmbedsDesc"), "removeEmbeds");
    this.toggleSetting(containerEl, t("removeHtmlCommentsName"), t("removeHtmlCommentsDesc"), "removeHtmlComments");
    this.textAreaSetting(
      containerEl,
      t("skipLinePatternsName"),
      t("skipLinePatternsDesc"),
      "skipLinePatterns"
    );

    new Setting(containerEl)
      .setName(t("voiceOptimizationHeading"))
      .setHeading();
    this.toggleSetting(
      containerEl,
      t("optimizeAcronymsName"),
      t("optimizeAcronymsDesc"),
      "optimizeAcronyms"
    );
    this.toggleSetting(
      containerEl,
      t("addPauseAtLineBreaksName"),
      t("addPauseAtLineBreaksDesc"),
      "addPauseAtLineBreaks"
    );
    new Setting(containerEl)
      .setName(t("lineBreakPauseTypeName"))
      .setDesc(t("lineBreakPauseTypeDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("period", t("lineBreakPausePeriod"))
          .addOption("comma", t("lineBreakPauseComma"))
          .setValue(this.plugin.settings.lineBreakPauseType)
          .onChange(async (value: "period" | "comma") => {
            this.plugin.settings.lineBreakPauseType = value;
            await this.plugin.saveSettings();
          })
      );

    this.toggleSetting(
      containerEl,
      t("addSpaceAfterPunctuationName"),
      t("addSpaceAfterPunctuationDesc"),
      "addSpaceAfterPunctuation"
    );

    if (this.plugin.settings.provider === "minimax") {
      this.displayMiniMaxSettings(containerEl, t);
    } else if (this.plugin.settings.provider === "replicate") {
      this.displayReplicateSettings(containerEl, t);
    } else {
      this.displayCustomSettings(containerEl, t);
    }
  }

  private displayMiniMaxSettings(containerEl: HTMLElement, t: (key: SettingsTextKey) => string) {
    new Setting(containerEl)
      .setName("MiniMax")
      .setHeading();
    this.textSetting(containerEl, "API Key", t("minimaxApiKeyDesc"), "minimaxApiKey", true);
    this.textSetting(containerEl, "Endpoint", t("minimaxEndpointDesc"), "minimaxEndpoint");
    this.textSetting(containerEl, "Model", t("minimaxModelDesc"), "minimaxModel");
    this.textSetting(containerEl, "Voice ID", t("minimaxVoiceIdDesc"), "minimaxVoiceId");
    this.textSetting(containerEl, "Language boost", t("minimaxLanguageBoostDesc"), "minimaxLanguageBoost");
    this.numberSetting(containerEl, "Speed", t("speedDesc"), "minimaxSpeed");
    this.numberSetting(containerEl, "Volume", t("volumeDesc"), "minimaxVolume");
    this.numberSetting(containerEl, "Pitch", t("pitchDesc"), "minimaxPitch");
  }

  private displayReplicateSettings(containerEl: HTMLElement, t: (key: SettingsTextKey) => string) {
    new Setting(containerEl)
      .setName("Replicate")
      .setHeading();
    this.textSetting(containerEl, "API Token", t("replicateApiTokenDesc"), "replicateApiToken", true);
    this.textSetting(
      containerEl,
      "Model",
      t("replicateModelDesc"),
      "replicateModel"
    );

    if ((this.plugin.settings.replicateModel || REPLICATE_MINIMAX_MODEL) === REPLICATE_MINIMAX_MODEL) {
      const selectedVoice = this.plugin.settings.replicateVoiceId === REPLICATE_CUSTOM_VOICE
        ? REPLICATE_CUSTOM_VOICE
        : REPLICATE_MINIMAX_VOICES.includes(this.plugin.settings.replicateVoiceId)
        ? this.plugin.settings.replicateVoiceId
        : "Wise_Woman";

      new Setting(containerEl)
        .setName("Voice")
        .setDesc(t("replicateVoiceDesc"))
        .addDropdown((dropdown) => {
          dropdown.addOption(REPLICATE_CUSTOM_VOICE, "Custom");
          for (const voice of REPLICATE_MINIMAX_VOICES) {
            dropdown.addOption(voice, voice);
          }
          dropdown
            .setValue(selectedVoice)
            .onChange(async (value) => {
              this.plugin.settings.replicateVoiceId = value;
              await this.plugin.saveSettings();
            });
        });

      this.textSetting(
        containerEl,
        "Custom voice ID",
        t("replicateCustomVoiceIdDesc"),
        "replicateCustomVoiceId"
      );

      new Setting(containerEl)
        .setName("Language preference")
        .setDesc(t("replicateLanguagePreferenceDesc"))
        .addDropdown((dropdown) =>
          dropdown
            .addOption("None", "Auto")
            .addOption("Chinese", "Chinese")
            .addOption("Cantonese", "Cantonese")
            .addOption("English", "English")
            .addOption("Japanese", "Japanese")
            .addOption("Korean", "Korean")
            .addOption("Spanish", "Spanish")
            .addOption("French", "French")
            .addOption("German", "German")
            .addOption("Portuguese", "Portuguese")
            .setValue(this.plugin.settings.replicateLanguageBoost === "auto" ? "None" : this.plugin.settings.replicateLanguageBoost || "None")
            .onChange(async (value) => {
              this.plugin.settings.replicateLanguageBoost = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Emotion")
        .setDesc(t("replicateEmotionDesc"))
        .addDropdown((dropdown) =>
          dropdown
            .addOption("auto", "Auto")
            .addOption("neutral", "Neutral")
            .addOption("happy", "Happy")
            .addOption("sad", "Sad")
            .addOption("angry", "Angry")
            .addOption("fearful", "Fearful")
            .addOption("disgusted", "Disgusted")
            .addOption("surprised", "Surprised")
            .addOption("calm", "Calm")
            .addOption("fluent", "Fluent")
            .setValue(this.plugin.settings.replicateEmotion || "auto")
            .onChange(async (value) => {
              this.plugin.settings.replicateEmotion = value;
              await this.plugin.saveSettings();
            })
        );

      this.numberSetting(containerEl, "Speed", t("replicateSpeedDesc"), "replicateSpeed");
      this.numberSetting(containerEl, "Volume", t("replicateVolumeDesc"), "replicateVolume");
      this.numberSetting(containerEl, "Pitch", t("replicatePitchDesc"), "replicatePitch");
      return;
    }

    new Setting(containerEl)
      .setName(t("advancedReplicateHeading"))
      .setHeading();
    this.textSetting(containerEl, "Model version", t("replicateVersionDesc"), "replicateVersion");
    this.textAreaSetting(containerEl, "Input JSON template", t("replicateInputTemplateDesc"), "replicateInputTemplate");
  }

  private displayCustomSettings(containerEl: HTMLElement, t: (key: SettingsTextKey) => string) {
    new Setting(containerEl)
      .setName("Custom HTTP")
      .setHeading();
    this.textSetting(containerEl, "Endpoint", t("customEndpointDesc"), "customEndpoint");
    this.textSetting(containerEl, "Method", t("customMethodDesc"), "customMethod");
    this.textAreaSetting(containerEl, "Headers JSON template", t("customHeadersDesc"), "customHeaders");
    this.textAreaSetting(containerEl, "Body JSON template", t("customBodyTemplateDesc"), "customBodyTemplate");
    this.numberSetting(containerEl, "Custom chunk characters", t("customChunkCharactersDesc"), "customChunkCharacters");
    this.textSetting(containerEl, "Audio URL path", t("customAudioUrlPathDesc"), "customAudioUrlPath");
    this.textSetting(containerEl, "Audio hex path", t("customAudioHexPathDesc"), "customAudioHexPath");
    this.textSetting(containerEl, "Audio base64 path", t("customAudioBase64PathDesc"), "customAudioBase64Path");
  }

  private textSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    key: keyof NoteTtsSettings,
    secret = false
  ) {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        if (secret) {
          text.inputEl.type = "password";
        }
        text.setValue(String(this.plugin.settings[key] ?? "")).onChange(async (value) => {
          (this.plugin.settings[key] as string) = value;
          await this.plugin.saveSettings();
        });
      });
  }

  private numberSetting(containerEl: HTMLElement, name: string, desc: string, key: keyof NoteTtsSettings) {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) =>
        text.setValue(String(this.plugin.settings[key] ?? "")).onChange(async (value) => {
          (this.plugin.settings[key] as number) = Number(value);
          await this.plugin.saveSettings();
        })
      );
  }

  private toggleSetting(containerEl: HTMLElement, name: string, desc: string, key: keyof NoteTtsSettings) {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) =>
        toggle.setValue(Boolean(this.plugin.settings[key])).onChange(async (value) => {
          (this.plugin.settings[key] as boolean) = value;
          await this.plugin.saveSettings();
        })
      );
  }

  private textAreaSetting(containerEl: HTMLElement, name: string, desc: string, key: keyof NoteTtsSettings) {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addTextArea((text) =>
        text
          .setValue(String(this.plugin.settings[key] ?? ""))
          .onChange(async (value) => {
            (this.plugin.settings[key] as string) = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

function renderJsonTemplate(template: string, text: string) {
  const rendered = template.replace(/{{text}}/g, escapeJsonStringContent(text));
  try {
    return JSON.parse(rendered);
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

function getByPath(value: any, path: string) {
  if (!path) return undefined;
  return path.split(".").reduce((current, key) => current?.[key], value);
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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

  return groupedChunks.filter(Boolean);
}

function hardSplitText(text: string, maxCharacters: number) {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxCharacters) {
    chunks.push(text.slice(index, index + maxCharacters));
  }
  return chunks;
}

function combineAudioResults(audios: AudioResult[], providerName: string): AudioResult {
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
      data: concatenateWavs(audioData),
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

function concatenateWavs(buffers: ArrayBuffer[]) {
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

  const dataSize = chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0);
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
  for (const chunk of chunks) {
    bytes.set(new Uint8Array(chunk.data), offset);
    offset += chunk.data.byteLength;
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
