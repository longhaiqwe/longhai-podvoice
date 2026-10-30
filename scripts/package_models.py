#!/usr/bin/env python3
"""按已审核清单构建可重复的模型 ZIP，不自动更新选型或校验值。"""

import argparse
import json
from pathlib import Path
import shutil
import sys
import tempfile
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from setup_models import DEFAULT_MANIFEST, ROOT, read_manifest, safe_relative, sha256


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="GPT-SoVITS 服务根目录")
    parser.add_argument("--output", type=Path, default=ROOT / "model-releases/podvoice-models-v1.zip")
    args = parser.parse_args()
    manifest = read_manifest(DEFAULT_MANIFEST)
    sources = []
    for entry in manifest["files"]:
        base = args.source if entry["source_root"] == "service" else ROOT
        source = base.joinpath(*safe_relative(entry["source_path"]).parts)
        if source.stat().st_size != entry["size"] or sha256(source) != entry["sha256"]:
            parser.error(f"源文件与选定清单不一致：{source}")
        sources.append((entry["archive_path"], source))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        parser.error(f"拒绝覆盖已有压缩包：{args.output}")
    with tempfile.TemporaryDirectory(prefix="podvoice-package-", dir=args.output.parent) as temporary:
        temporary = Path(temporary)
        manifest_path = temporary / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        sources.append(("manifest.json", manifest_path))
        archive = temporary / "models.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
            for name, source in sorted(sources):
                info = zipfile.ZipInfo(name, date_time=(2026, 10, 30, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                with source.open("rb") as incoming, bundle.open(info, "w") as output:
                    shutil.copyfileobj(incoming, output, 1024**2)
        # 校验打包过程中源文件未发生变化。
        with zipfile.ZipFile(archive) as bundle:
            import hashlib
            for entry in manifest["files"]:
                digest = hashlib.sha256()
                with bundle.open(entry["archive_path"]) as stream:
                    for chunk in iter(lambda: stream.read(1024**2), b""):
                        digest.update(chunk)
                if digest.hexdigest() != entry["sha256"]:
                    parser.error(f"打包时源文件发生变化：{entry['archive_path']}")
        archive.rename(args.output)
    checksum = sha256(args.output)
    checksum_file = args.output.with_suffix(".zip.sha256")
    checksum_file.write_text(f"{checksum}  {args.output.name}\n", encoding="ascii")
    print(json.dumps({"zip": str(args.output), "bytes": args.output.stat().st_size, "sha256": checksum}, ensure_ascii=False))


if __name__ == "__main__":
    main()
