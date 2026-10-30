# 刘飞、孟岩音色：本地使用与发布准备

整理日期：2026-10-30。当前状态：**仅完成本地准备，尚未公开发布。取得孟岩、刘飞两位对声音模型公开分发的同意后，再安排 GitHub Release。** 本次未上传、推送或创建公开 Release；仓库也尚未配置 Git 远程地址。插件代码的许可证不代表这些声音素材和模型已经获得公开分发许可。

## 选定的两套模型

实际源目录在本插件仓库相邻的 `../GPT-SoVITS/` 中。检查了 `GPT_weights_v2/`、`SoVITS_weights_v2/`、`reference_audio/`，完整文件名与大小见 [inventory-v1.json](inventory-v1.json)。发布包版本号 `v1` 与 GPT-SoVITS 模型架构版本 `v2` 是两回事。

| 音色 | GPT 权重 | SoVITS 权重 | 主参考 WAV／同名 JSON |
| --- | --- | --- | --- |
| 刘飞 | `liufei-e15.ckpt` | `liufei_clean_20260930_e2_s160.pth` | `liufei_02_chat.wav`／`liufei_02_chat.json` |
| 孟岩 | `mengyan_v2-e25.ckpt` | `mengyan_clean_20260930_e2_s166.pth` | `mengyan_03_philosophy.wav`／`mengyan_03_philosophy.json` |

刘飞主参考提示文本：

> 而关于折叠屏手机的一些讨论本身就挺有意思的。

孟岩主参考提示文本：

> 像是在一个巨大的房间里面进行搜索。那终其一生，我们可能只能了解这个巨大房间的非常非常有限的一个角落。

两者提示语言均为 `zh`。JSON 标注使用 `prompt_language`，API 请求使用 `prompt_lang`，不可把标注 JSON 直接作为完整 `/tts` 请求。安装器另行生成请求 JSON。

选型依据是当前插件的实际配置与已有对照记录，并非按修改日期或训练轮数排序。10 月 29 日的 [24 段 GPT 对照](../audits/20261029-clean-e2-comparison/对照说明.md)不足以证明清洗 GPT e2 全面更好，所以保留历史 GPT，搭配已训练的专属 SoVITS e2。另参考 [刘飞真实合成验证](../audits/20261030-liufei-verification/验证记录.md)和[逐句声学解码验证](../audits/20261029-drawn-out-words/排查与修正.md)。本次未重新训练、穷举所有权重或进行主观听感排名；“最终包”仅指本次固定的部署组合，不表示已证明其在所有文本上最稳定。

## 辅助参考与路径兼容

代码对每种音色实际使用一个主参考和两个辅助参考。只打包主参考会遗漏现有调用依赖，因此本包包含全部六个 WAV，且每个 WAV 都有同名 JSON。

| 音色 | 辅助参考文件 | 原有文字标注 |
| --- | --- | --- |
| 刘飞 | `liufei_raw_6min.wav_0000128000_0000342400.wav` | 大家都在讨论。而关于折叠屏手机的一些讨论本身就挺有意思的。 |
| 刘飞 | `liufei_raw_6min.wav_0007375680_0007662400.wav` | 更想从一个做过手机产品经理的视角。对，现在回想起来挺有意思的。在十几年前，我居然还是做过手机的产品经理的。 |
| 孟岩 | `mengyan_02_chat.wav` | 但即使是这样，即使是在创业维艰的5年之后，我们的收入也没有多少。 |
| 孟岩 | `mengyan_raw_6min.wav_0008983040_0009070720.wav` | 他已经捐出了6亿美元，却无人知晓。 |

包内六个 WAV 都归入 `reference_audio/`。安装时还会把三个 `*_raw_6min*` 文件复制至插件代码原先引用的 `dataset/liufei/wavs/` 或 `dataset/mengyan/wavs/`。这些是部署兼容副本，不是完整训练数据集。辅助参考的文本仅作存档，当前 API 不接收其逐条提示文本。

现有刘飞主参考与孟岩闲聊参考的 JSON 保留原始内容。孟岩主参考原来没有 JSON，本次按 `main.ts` 中正在使用的提示文本补齐；三个训练切片的 JSON 按原 `.list` 标注补齐。新标注记录了来源，未声称重新人工听音校对。原训练清单中孟岩主参考对应片段写作“终奇一生”，运行代码使用“终其一生”；新部署标注遵循运行代码，未修改原训练清单。

## 本地一键安装

需要 Python 3.9 或以上，安装脚本只用标准库。下列命令在**插件仓库根目录**执行：

```bash
python3 setup_models.py --zip model-releases/podvoice-models-v1.zip --target ../GPT-SoVITS --device mps
```

其他机器将 `--target` 改为 GPT-SoVITS 服务根目录。Apple Silicon 使用 `mps`；CPU 使用 `cpu`；有 CUDA 的机器可选 `cuda`。配置统一使用 float32，不自动启用半精度。

安装行为：

1. 将包内 `manifest.json` 与仓库中的 [可信发布清单](podvoice-models-v1.manifest.json)比较，核对文件列表、大小和逐文件 SHA-256。
2. 校验完成后，把 `GPT_weights/` 映射到 `GPT_weights_v2/`，把 `SoVITS_weights/` 映射到 `SoVITS_weights_v2/`，安装参考与兼容副本。
3. 生成 `podvoice-configs/liufei.yaml`、`mengyan.yaml` 以及两个同名的 `.request.json`。
4. 相同内容跳过；发现不同内容的现有文件时，在写入前停止。需要变更生成配置中的设备时，先备份并移走旧生成配置，再安装。不覆盖原来的 `GPT_SoVITS/configs/tts_infer.yaml`，不重启服务。

安装器拒绝包内额外文件、目录穿越与符号链接。建议预留至少 1.5 GiB 可用磁盘空间，供压缩包、校验暂存和安装副本使用。安装期间请勿让其他进程修改同一目标目录；文件复制过程中发生异常时会删除本次新建文件。

## 启动与切换音色

模型包不包含 Python 推理环境、服务源码、中文 BERT、HuBERT 和文本前端资源。需要使用本项目已配置好的 GPT-SoVITS 服务。兼容版本的关键源码 SHA-256 记录在发布清单中；本机服务包含尚未包含在其 Git 提交中的修改，仅检出相同上游提交不能复现这些修改。

本地服务支持 `gpt_weights_path`、`sovits_weights_path`、`cut_podcast`、`independent_decode` 等项目扩展。未经适配的上游服务不能保证执行这些参数。当前服务使用 `custom` 配置块优先加载权重；只修改配置文件中的 `v2` 块不会覆盖已有 `custom`。

在已安装依赖的 `gpt-sovits` Conda 环境启动，**工作目录必须是 GPT-SoVITS 根目录**：

```bash
cd ../GPT-SoVITS
conda run --no-capture-output -n gpt-sovits python api_v2.py -a 127.0.0.1 -p 9880 -c podvoice-configs/liufei.yaml
```

若希望服务启动时先加载孟岩，把 `-c` 改为 `podvoice-configs/mengyan.yaml`。已有服务占用 9880 时，不要重复启动；本次准备工作没有中断现有服务。YAML 中 `t2s_weights_path` 对应 GPT，`vits_weights_path` 对应 SoVITS；主参考和提示文本由每次请求提供。

服务启动后，可在另一个终端从服务根目录执行：

```bash
curl --fail-with-body -X POST http://127.0.0.1:9880/tts \
  -H 'Content-Type: application/json' \
  --data-binary @podvoice-configs/liufei.request.json -o liufei-sample.wav

curl --fail-with-body -X POST http://127.0.0.1:9880/tts \
  -H 'Content-Type: application/json' \
  --data-binary @podvoice-configs/mengyan.request.json -o mengyan-sample.wav
```

两个请求串行执行，服务按请求中的两阶段路径切换音色；不是把两套模型同时常驻运行。修改请求 JSON 的 `text` 即可生成其他文字。请求示例按当前插件默认值设置温度 0.82、top-p 0.95、top-k 15、语速 1、batch 2、非流式输出、逐句声学解码；刘飞分句间隔 0.28／重复惩罚 1.28，孟岩为 0.35／1.25。这些值不是重新评测所得的新最优参数。

在 Obsidian 插件中选择本地 GPT-SoVITS，地址为 `http://127.0.0.1:9880/tts`，音色选择“刘飞”或“孟岩”即可。插件的内部预设 ID 分别是 `liufei_acoustic_candidate` 和 `mengyan_acoustic_candidate`。安装器保留现有代码依赖的路径，因此无需修改插件源代码。直接调用 API 不会执行插件的数字、时间等文本预处理。

## 本地包与未来下载入口

本地文件为 `model-releases/podvoice-models-v1.zip`，同目录包含 `.zip.sha256` 校验文件。ZIP 根目录结构：

```text
GPT_weights/       # 两个 ckpt
SoVITS_weights/    # 两个 pth
reference_audio/   # 六个 wav、六个同名 json
manifest.json
```

重建时执行以下命令；工具拒绝覆盖已有同名包，需要另选输出位置。它先核对源文件与固定清单的哈希，再打包，不会悄悄更新选型。相同输入与 Python/zlib 工具链下可重复构建。

```bash
python3 scripts/package_models.py --source ../GPT-SoVITS --output /tmp/podvoice-models-v1.zip
```

下载功能已实现，当前没有公开下载地址。取得两位同意并完成未来发布后，才可将 Release Asset 或镜像的**直接下载地址**传给 `--url`，例如：

```bash
python3 setup_models.py --url '<经确认的直接下载地址>' --target /path/to/GPT-SoVITS --device cpu --sha256 '<该包的SHA-256>'
```

上述占位符不是可用地址。`--sha256` 为可选整包校验，逐文件校验始终启用；下载不会执行远端代码。换用其他包版本时必须同时使用经过审核的对应清单，不应直接信任下载包自己附带的清单。

## Git 防漏与验证

`.gitignore` 已忽略模型扩展名、模型目录、本地参考目录和 `model-releases/`。Git 忽略规则无法按大小判断，也不会取消已经跟踪的文件；提交前再运行索引检查：

```bash
python3 scripts/check_git_large_files.py
python3 -m unittest discover -s tests -p 'test_setup_models.py' -v
```

索引检查会阻止检查通过时遗漏超过 50 MiB 的普通文件；它不是自动安装的 Git 钩子，必须执行。不要使用 `git add -f` 绕过模型忽略规则。当前声音包仅本地保存，尚不进行任何 GitHub 上传。

本次安装与打包验证结果见 [verification-v1.json](verification-v1.json)。检查覆盖文件完整性、路径分发、生成配置和安装边界；不等同于新机器上的推理环境验收，也不代表新的听感评分。
