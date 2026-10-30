#!/usr/bin/env python3
"""安装经过清单校验的 PodVoice 模型包；仅依赖 Python 3.9+ 标准库。"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import urllib.parse
import urllib.request
import zipfile


ROOT = Path(__file__).resolve().parent
DEFAULT_MANIFEST = ROOT / "models/podvoice-models-v1.manifest.json"
MAX_DOWNLOAD = 2 * 1024**3
CHUNK = 1024**2


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_relative(value):
    if not isinstance(value, str) or not value or "\\" in value or ":" in value:
        raise ValueError(f"非法相对路径：{value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(p in ("", ".", "..") for p in value.split("/")):
        raise ValueError(f"非法相对路径：{value!r}")
    return path


def destination(root, relative):
    path = root.joinpath(*safe_relative(relative).parts)
    # 即使链接指向目标目录内部，也拒绝沿链接写入。
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError(f"目标路径包含符号链接：{part}")
        if part == root:
            break
    return path


def read_manifest(path):
    manifest = json.loads(Path(path).read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1 or not manifest.get("files"):
        raise ValueError("不支持的清单版本或空文件清单")
    archives, targets = set(), set()
    for entry in manifest["files"]:
        archive = str(safe_relative(entry["archive_path"]))
        if archive.split("/")[0] not in ("GPT_weights", "SoVITS_weights", "reference_audio"):
            raise ValueError(f"不支持的包内目录：{archive}")
        if archive.casefold() in archives:
            raise ValueError(f"重复包内路径：{archive}")
        archives.add(archive.casefold())
        if not isinstance(entry["size"], int) or not 0 < entry["size"] <= MAX_DOWNLOAD:
            raise ValueError(f"非法大小：{archive}")
        digest = entry["sha256"]
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError(f"非法 SHA-256：{archive}")
        if not entry["install_paths"]:
            raise ValueError(f"缺少安装路径：{archive}")
        for target in entry["install_paths"]:
            target = str(safe_relative(target))
            if target.split("/")[0] not in ("GPT_weights_v2", "SoVITS_weights_v2", "reference_audio", "dataset"):
                raise ValueError(f"不支持的安装目录：{target}")
            if target.casefold() in targets:
                raise ValueError(f"重复安装路径：{target}")
            targets.add(target.casefold())
    if sum(e["size"] for e in manifest["files"]) > MAX_DOWNLOAD:
        raise ValueError("清单总大小超过限制")
    return manifest


def download(url, output):
    if urllib.parse.urlparse(url).scheme not in ("https", "http"):
        raise ValueError("下载地址必须使用 HTTPS 或 HTTP")
    request = urllib.request.Request(url, headers={"User-Agent": "PodVoice-model-setup/1"})
    with urllib.request.urlopen(request, timeout=30) as response, output.open("wb") as stream:
        if urllib.parse.urlparse(response.geturl()).scheme not in ("https", "http"):
            raise ValueError("下载重定向协议不受支持")
        size = 0
        while True:
            chunk = response.read(CHUNK)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_DOWNLOAD:
                raise ValueError("下载大小超过 2 GiB")
            stream.write(chunk)


def verify_archive(archive, manifest, staging):
    """先完整校验，再允许写入服务目录；不调用 extractall。"""
    entries = {e["archive_path"]: e for e in manifest["files"]}
    with zipfile.ZipFile(archive) as bundle:
        infos = bundle.infolist()
        names = [i.filename for i in infos]
        if len(names) != len(set(names)) or set(names) != set(entries) | {"manifest.json"}:
            raise ValueError("ZIP 文件列表与已知清单不一致（缺失、额外或重复文件）")
        for info in infos:
            safe_relative(info.filename)
            mode = info.external_attr >> 16
            if info.is_dir() or stat.S_ISLNK(mode) or stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                raise ValueError(f"ZIP 包含非普通文件：{info.filename}")
            expected_size = entries[info.filename]["size"] if info.filename in entries else 1024**2
            if (info.filename == "manifest.json" and info.file_size > expected_size) or (info.filename in entries and info.file_size != expected_size):
                raise ValueError(f"ZIP 文件大小不匹配：{info.filename}")
        if json.loads(bundle.read("manifest.json")) != manifest:
            raise ValueError("包内清单与仓库中的已知清单不一致")
        for name, entry in entries.items():
            output = destination(staging, name)
            output.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(name) as source, output.open("wb") as target:
                shutil.copyfileobj(source, target, CHUNK)
            if output.stat().st_size != entry["size"] or sha256(output) != entry["sha256"]:
                raise ValueError(f"SHA-256 校验失败：{name}")


def config_files(manifest, device):
    result = {}
    for voice_id, voice in manifest["voices"].items():
        safe_relative(voice_id)
        if "/" in voice_id:
            raise ValueError("音色 ID 不可包含目录")
        request = voice["request"]
        custom = {
            "device": device, "is_half": False, "version": "v2",
            "bert_base_path": "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large",
            "cnhuhbert_base_path": "GPT_SoVITS/pretrained_models/chinese-hubert-base",
            "t2s_weights_path": request["gpt_weights_path"],
            "vits_weights_path": request["sovits_weights_path"],
        }
        # JSON 标量也是合法 YAML，避免引入 PyYAML 安装依赖。
        yaml = "custom:\n" + "".join(f"  {k}: {json.dumps(v, ensure_ascii=False)}\n" for k, v in custom.items())
        result[f"podvoice-configs/{voice_id}.yaml"] = yaml.encode("utf-8")
        result[f"podvoice-configs/{voice_id}.request.json"] = (json.dumps(request, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    return result


def install(archive, target, manifest, device="cpu", expected_sha256=None):
    if expected_sha256 and sha256(archive) != expected_sha256.lower():
        raise ValueError("ZIP SHA-256 不匹配")
    # 拒绝目标本身的链接；允许 macOS /var -> /private/var 等父级系统别名。
    target = Path(os.path.abspath(target))
    if target.is_symlink():
        raise ValueError(f"目标路径包含符号链接：{target}")
    target = target.resolve()
    destination(target, "podvoice-configs")
    with tempfile.TemporaryDirectory(prefix="podvoice-models-") as temporary:
        staging = Path(temporary)
        verify_archive(archive, manifest, staging)
        planned = []
        for entry in manifest["files"]:
            source = staging / entry["archive_path"]
            for relative in entry["install_paths"]:
                planned.append((source, destination(target, relative), entry["sha256"]))
        for relative, content in config_files(manifest, device).items():
            source = staging / relative
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(content)
            planned.append((source, destination(target, relative), sha256(source)))
        # 所有冲突先检查；同内容跳过，不覆盖任何不同内容的现有文件。
        pending = []
        for source, output, digest in planned:
            if output.exists():
                if not output.is_file() or sha256(output) != digest:
                    raise ValueError(f"目标已存在且内容不同，请先备份并移走：{output}")
            else:
                if any(p.exists() and not p.is_dir() for p in output.parents):
                    raise ValueError(f"目标父路径不是目录：{output}")
                pending.append((source, output))
        written = []
        try:
            for source, output in pending:
                output.parent.mkdir(parents=True, exist_ok=True)
                destination(target, output.relative_to(target).as_posix())
                # x 模式阻止检查后出现的新文件被覆盖；异常时删除本次新建文件。
                with output.open("xb") as stream:
                    written.append(output)
                    with source.open("rb") as incoming:
                        shutil.copyfileobj(incoming, stream, CHUNK)
        except BaseException:
            for output in reversed(written):
                output.unlink()
            raise
    return {"verified_files": len(manifest["files"]), "installed": len(pending), "unchanged": len(planned) - len(pending)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--zip", type=Path, help="本地模型 ZIP")
    source.add_argument("--url", help="GitHub Release Asset 或镜像的直接下载地址")
    parser.add_argument("--target", type=Path, required=True, help="GPT-SoVITS 服务根目录")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST, help="可信的本地发布清单")
    parser.add_argument("--sha256", help="可选：整包 SHA-256；逐文件校验始终执行")
    parser.add_argument("--device", choices=("cpu", "mps", "cuda"), default="cpu")
    args = parser.parse_args()
    try:
        manifest = read_manifest(args.manifest)
        with tempfile.TemporaryDirectory(prefix="podvoice-download-") as temporary:
            archive = args.zip
            if args.url:
                archive = Path(temporary) / "models.zip"
                print("正在下载模型包……", flush=True)
                download(args.url, archive)
            result = install(archive, args.target, manifest, args.device, args.sha256)
        print(json.dumps(result, ensure_ascii=False))
        print(f"配置已准备：{args.target.absolute() / 'podvoice-configs'}")
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, RuntimeError) as error:
        parser.exit(1, f"安装失败：{error}\n")


if __name__ == "__main__":
    main()
