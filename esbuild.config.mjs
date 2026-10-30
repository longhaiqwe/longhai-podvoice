import esbuild from "esbuild";
import { builtinModules } from "module";
import process from "process";
import fs from "fs";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  banner: {
    js: "/* Longhai PodVoice Obsidian plugin */\n/* Bundled jsdiff license:\n" + fs.readFileSync("node_modules/diff/LICENSE", "utf8") + "\n*/",
  },
  define: { PODVOICE_SPEECH_TIMING_SOURCE: JSON.stringify(fs.readFileSync("speech-timing.cjs", "utf8")) },
  entryPoints: ["main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@electron/remote",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

if (prod) {
  await context.rebuild();
  await context.dispose();

} else {
  await context.watch();
}
