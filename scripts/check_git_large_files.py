#!/usr/bin/env python3
"""检查 Git 索引中的 blob；忽略规则无法按文件大小筛选，也不影响已跟踪文件。"""

import subprocess
import sys

LIMIT = 50 * 1024**2


def main():
    records = subprocess.check_output(["git", "ls-files", "--stage", "-z"]).split(b"\0")
    indexed = []
    for record in records:
        if not record:
            continue
        metadata, path = record.split(b"\t", 1)
        mode, oid, stage = metadata.split()
        if mode == b"160000":  # 子模块的对象不在本仓库中。
            continue
        indexed.append((oid, path))
    if not indexed:
        print("Git 索引为空。")
        return 0
    output = subprocess.check_output(
        ["git", "cat-file", "--batch-check=%(objectsize)"],
        input=b"\n".join(oid for oid, _ in indexed) + b"\n",
    ).splitlines()
    oversized = [(path, int(size)) for (_, path), size in zip(indexed, output) if int(size) > LIMIT]
    for path, size in oversized:
        print(f"超过 50 MiB：{path.decode('utf-8', errors='replace')}（{size} 字节）", file=sys.stderr)
    if oversized:
        return 1
    print(f"已检查 Git 索引中的 {len(indexed)} 个文件，无超过 50 MiB 的文件。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
