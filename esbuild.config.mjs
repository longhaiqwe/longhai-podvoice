import esbuild from "esbuild";
import { builtinModules } from "module";
import process from "process";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  banner: {
    js: "/* Longhai PodVoice Obsidian plugin */\n/* Bundled jsdiff license:\n" + fs.readFileSync("node_modules/diff/LICENSE", "utf8") + "\n*/",
  },
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

  const vaultPluginDir =
    "/Users/longhai/Library/Mobile Documents/iCloud~md~obsidian/Documents/龙海的数字花园/.obsidian/plugins/longhai-podvoice";
  let deployed = false;
  try {
    if (fs.existsSync(vaultPluginDir)) {
      fs.copyFileSync("main.js", path.join(vaultPluginDir, "main.js"));
      fs.copyFileSync("speech-timing.cjs", path.join(vaultPluginDir, "speech-timing.cjs"));
      if (fs.existsSync("styles.css")) {
        fs.copyFileSync("styles.css", path.join(vaultPluginDir, "styles.css"));
      }
      if (fs.existsSync("manifest.json")) {
        fs.copyFileSync("manifest.json", path.join(vaultPluginDir, "manifest.json"));
      }
      deployed = true;
    }
  } catch (err) {
    try {
      const appleScript = `
        set sourceFiles to {POSIX file "${path.resolve("main.js")}" as alias, POSIX file "${path.resolve("speech-timing.cjs")}" as alias, POSIX file "${path.resolve("styles.css")}" as alias, POSIX file "${path.resolve("manifest.json")}" as alias}
        set dstFolder to POSIX file "${vaultPluginDir}/" as alias
        tell application "Finder"
          duplicate sourceFiles to dstFolder with replacing
        end tell
      `;
      execSync(`osascript -e '${appleScript.trim().replace(/'/g, "'\\''")}'`, { stdio: "ignore" });
      deployed = true;
    } catch (osaErr) {
      console.warn(`[Auto-Deploy] 写入 iCloud 失败: ${osaErr.message}`);
    }
  }
  if (deployed) {
    console.log(`[Auto-Deploy] ✓ 已自动同步最新构建至 Obsidian 插件目录: ${vaultPluginDir}`);
  }
} else {
  await context.watch();
}
