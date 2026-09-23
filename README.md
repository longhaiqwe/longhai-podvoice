# Note TTS

Note TTS is an Obsidian plugin that turns the current note or selected text into an MP3 audio file through your own TTS API provider. The generated audio is saved inside your vault and opened in a built-in playback modal.

## Features

- Command palette actions for `Convert current note to speech` and `Convert selected text to speech`
- Ribbon button for converting the current note
- Editor context menu actions for converting the whole note or the current selection
- File menu action for converting a Markdown file, useful on mobile when long-pressing a file
- `Preview cleaned text for speech` command to inspect the text before it is sent to TTS
- Markdown cleanup options for frontmatter, tags, links, raw URLs, images/embeds, HTML comments, and custom skipped-line rules
- MiniMax HTTP T2A support
- Official Replicate MiniMax Speech 2.8 Turbo preset
- Advanced Replicate version/template mode for other TTS models
- Custom HTTP provider support
- Generated files are saved to `TTS Audio/` by default
- Playback modal after generation, with actions to open the audio file or copy its path

## Install For Obsidian Testing

Copy these files into your vault plugin folder:

```text
<your vault>/.obsidian/plugins/note-tts/
  manifest.json
  main.js
  styles.css
```

Then enable `Note TTS` in Obsidian's community plugins settings.

## MiniMax Setup

Choose `MiniMax` in the plugin settings and fill in:

- `API Key`
- `Model`: defaults to `speech-2.8-turbo`
- `Voice ID`: defaults to `Chinese_Mandarin_Gentleman`; you can also use another system voice or a cloned voice ID
- `Language boost`: use `auto` for automatic detection, or `Chinese` for Chinese text

The plugin calls `https://api.minimax.io/v1/t2a_v2` and expects MiniMax to return MP3 audio data as hex.

## Replicate Setup

Choose `Replicate` in the plugin settings and fill in:

- `API Token`
- `Model`: defaults to `minimax/speech-2.8-turbo`
- `Voice`: choose a MiniMax Speech 2.8 Turbo system voice; choose `Custom` to use the next field
- `Custom voice ID`: used when `Voice` is set to `Custom`, usually for a MiniMax voice-cloning `voice_id`
- `Language preference`: defaults to `Auto`
- `Emotion`: defaults to `Auto`

The default model calls Replicate's official model endpoint:

```text
https://api.replicate.com/v1/models/minimax/speech-2.8-turbo/predictions
```

To use another Replicate model, change `Model` to another `owner/name`, then fill in:

- `Model version`: the Replicate model version hash
- `Input JSON template`: for example:

```json
{
  "text": "{{text}}"
}
```

Different Replicate TTS models may require different input fields. You can edit the template to match the model, such as `prompt`, `voice`, or `language`. The plugin polls the prediction, finds the first audio URL in the output, downloads it, and saves it to your vault.

## Custom HTTP Provider

A custom provider can return:

- A direct binary audio response
- An audio URL in JSON
- Hex audio data in JSON
- Base64 audio data in JSON

Use `Audio URL path`, `Audio hex path`, or `Audio base64 path` to specify the JSON path, for example `data.audio_url`.
