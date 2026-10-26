# 内容生成流程 / Content pipeline

前端开发、测试和发布使用仓库中的 `public/atlas/`，运行 `npm run build` 即可生成网站。只有维护或重新生成词库内容时，才需要下面的 `.local/forge/` 管道和服务凭据。没有生成源文件时，不要运行 `build:atlas` 来代替前端构建。

生成脚本位于 [`scripts/atlas/`](../scripts/atlas/)，中间产物写入被 Git 忽略的 `.local/forge/`。凭据从环境变量或仓库外目录读取，见 [SECURITY.md](../SECURITY.md)。网页和 CI 的离线回归不调用文本、图片或语音生成服务。

## 1. 词头输入与离线校验

准备 UTF-8 文件 `.local/forge/headwords.json`，顶层是非空数组：

```json
[
  { "hid": 1, "word": "library" },
  { "hid": 2, "word": "laboratory", "raw": null },
  { "hid": 3, "word": "research", "raw": ["研究", "科研工作"] }
]
```

- `hid` 是文件内唯一的非负整数，后续图片和语音中间文件使用它命名。
- `word` 是非空字符串，首尾空白会被去掉。
- `raw` 是可选的字符串数组；省略、`null`、空数组都表示没有义项提示。空白提示会被忽略，提交给模型的提示合计最多 160 个字符。
- 字符串形式的 `raw`、对象、数字、布尔值或含非字符串元素的数组均属于输入错误，不会被静默转换或拆成单个字符。

先执行不读取凭据、不访问模型、不创建输出的检查：

```bash
python3 scripts/atlas/gen_text.py --check-input
```

脚本先校验整个文件，再应用 `--start`、`--limit` 选择。任一行不合法、文件缺失或 JSON 损坏都会在提交任务前报出 `Input error` 并以状态码 2 退出；旧批次文件保留。这样不会出现前面的合法批次已经产生调用费用，后面的输入类型错误才被发现的情况。

`raw` 仅用于判断哪些义项重要。文本提示要求原创释义与例句，仍需维护者检查来源和最终内容。

## 2. 生成文本与媒体

[`gen_text.py`](../scripts/atlas/gen_text.py) 默认每批 **20** 个词、8 个工作线程，输出 `.local/forge/text/<批次号>.json`。它支持 `--batch`、`--workers`、`--start`、`--limit`、`--model`、`--out`；使用服务商实际提供的模型 ID。生成批次有失败时，进程以状态码 1 退出，日志列出失败批次。

凭据由 `SUB2_BASE_URL`、`SUB2_API_KEY`、`ELEVENLABS_API_KEY` 或 `ATLAS_SECRETS` 指定的外部目录提供。`SUB2_BASE_URL` 对应脚本使用的兼容聊天/图像接口；不要把凭据放进 `VITE_*` 变量。下面的生成命令会调用配置的外部服务：

```bash
python3 scripts/atlas/gen_text.py --model YOUR_TEXT_MODEL --workers 8 --batch 20
python3 scripts/atlas/gen_images.py --workers 6
python3 scripts/atlas/gen_word_audio.py --workers 6
python3 scripts/atlas/gen_sentence_audio.py --workers 3 --example 0
python3 scripts/atlas/gen_sentence_audio.py --workers 3 --example 1
```

| 阶段 | 输出和说明 |
| --- | --- |
| 文本 | 每词有释义、英美 IPA、日常/学术例句、搭配、提示和插画场景；具体结构见脚本内的编写规范 |
| 插画 | 根据 `scene` 和统一画风生成图片，保存 768px WebP 母版；需要本机安装 `cwebp` |
| 单词发音 | 英音、美音分别进入 `audio/uk`、`audio/us`；声音与模型 ID 见 `gen_word_audio.py` |
| 日常例句 | `--example 0` 为 `ex[0]` 生成音频，进入 `audio/ex` |
| 学术例句 | `--example 1` 为 `ex[1]` 生成音频，进入 `audio/ex2` |

图片与例句脚本的 `--follow` 会持续跟随新文本，适合维护者需要并行生成时使用。普通一次性运行不必开启。声音额度下限、模型和可用声音需按实际服务配置。

已有批次或媒体文件会被跳过。断点续跑时保持词头顺序、批大小和输出目录一致；改变输入范围或批大小后应使用新的 `--out` 目录并人工核对，避免把旧批次号误认为新任务。已损坏的批次需先确认并重新生成，不能仅凭文件存在认定成功。

## 3. 安全编译公开词库

```bash
python3 scripts/atlas/build_atlas.py
npm run check:atlas
```

编译器清洗、排序并切分词条，生成 `public/atlas/`、`data/word-atlas.json`、CSV 和构建警告文件。图片转换依赖 `cwebp`。

编译开始前会验证所有文本输入。缺少源目录、空源、坏 JSON、不完整词条或非法字段会中止；既有公开词库和下载数据保持原样。通过验证后，在临时目录生成并检查索引、分块、下载数据和媒体引用，成功后才替换输出。普通写入或替换异常会回滚已替换目录；回滚自身失败时保留恢复材料并报告位置。这是异常回滚机制，不是断电情况下的多目录事务日志。临时副本需要额外磁盘空间。

只改文字、不重新转换媒体时可以使用：

```bash
python3 scripts/atlas/build_atlas.py --no-media
```

此选项只把公开输出中确实存在的非空媒体写进媒体标志；图片还需同时有母图和缩略图。它不会把仅存在于 forge 的媒体冒充已发布文件。不要在故意省略媒体的稀疏检出上用它“修复”校验结果。

公开索引、分块、下载 JSON/CSV 应保持一致。手工修正文本后，先运行完整结构检查，再构建前端。`check:atlas` 检查结构、顺序、引用和声明的媒体文件存在性；不能证明翻译、发音或图片语义正确。

## 4. 前端发布产物与缓存

```bash
npm run build
```

[`scripts/atlas-release.ts`](../scripts/atlas-release.ts) 在 `dist/` 中生成带内容哈希和完整性信息的词条分块，再写入引用它们的索引，不修改 `public/` 源文件。[`scripts/offline-release.ts`](../scripts/offline-release.ts) 根据实际构建输出生成页面预缓存清单和 Service Worker；媒体摘要也参与版本计算。

页面、索引、JS/CSS、字体、图标和品牌图在首次安装时预缓存。词条分块和学习媒体按访问情况缓存，首次控制页面之前的请求也会尝试补入。新 worker 等待旧页面退出后激活；离线缓存并不等于全量下载所有词条和媒体。部署顺序、缓存头、HTTPS/Web Locks 要求以及离线限制见 [deployment.md](deployment.md)。

## 5. 公开源码导出

```bash
python3 scripts/package_public.py --out ../word-atlas-public
```

导出器按白名单复制源码、工作流、文档和公开数据，扫描后生成 `PUBLIC_MANIFEST.json` 与输出标识。网站部署使用 `dist/`；这里得到的是可公开的源码目录。

目标必须在项目目录及其祖先之外。新的空目录、仅有 Git 元数据的仓库，或具有有效导出清单的旧输出可使用；陌生非空目录、符号链接目标以及混入用户额外文件的旧输出会被拒绝。旧输出不会先被清空：新产物扫描与校验通过后才替换，既有 Git 元数据保留；扫描或正常替换失败时保留原数据。

## 6. 回归检查与 CI

| 命令 | 覆盖内容 |
| --- | --- |
| `npm test` | 存储校验、writer 生命周期、文本/打字、今日时钟、词库发布与离线辅助逻辑 |
| `npm run test:pipeline` | 标准库 Python 测试；临时目录内验证缺源保护、事务回滚、安全导出及 `raw` 输入；模型调用全部替身化 |
| `npm run check:atlas` | 完整工作树中的真实词条和媒体引用 |
| `npm run build` | TypeScript 检查和真实生产构建 |
| `npm run test:e2e` | Chromium 中的加载重试、快捷键、writer 交接、备份和练习等交互回归 |
| `npm run test:e2e:storage` | 存储配额失败、RAM 导出、设置补写、导入回滚和跨窗口恢复冲突 |
| `npm run test:e2e:offline` | 独立生产构建中的首次访问离线、缓存范围、音频范围响应与升级生命周期 |

首次运行浏览器测试前安装测试浏览器：

```bash
npx playwright install --with-deps chromium
npm run test:e2e -- --output output/e2e-regressions.json
npm run test:e2e:storage -- --output output/e2e-storage-failures.json
npm run test:e2e:offline -- --output output/e2e-offline.json
```

脚本启动自己的本地服务，使用全新的隔离浏览器存储，结束后关闭服务和浏览器；不连接用户浏览器或线上站点。可通过 `ATLAS_CHROMIUM_EXECUTABLE` 指定已安装的 Chromium；额外参数见各脚本开头说明。

[`check.yml`](../.github/workflows/check.yml) 和手动 Pages 构建会完整检出受版本控制的媒体并执行上述检查。本地使用稀疏代码目录时，必须明确区分“代码/测试通过”和“完整媒体检查通过”。隔离浏览器夹具用于验证程序行为，不能代替真实媒体完整性检查。

## 质量边界

自动化覆盖结构、字段、顺序、持久化失败和关键交互，不证明生成内容的语义正确。插画和例句没有逐条人工审校；发现问题请附词条 ID、复现步骤和建议修改方式提交 Issue 或 PR。
