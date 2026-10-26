# 三批审计修复与验收记录

审计基线为 [`9eff300e5d5d0b31dcd9de2a4e040a89c78cbcc8`](https://github.com/ecofree/word-atlas/commit/9eff300e5d5d0b31dcd9de2a4e040a89c78cbcc8)。本次按照先保护数据和学习流程、再修判分与统计、最后处理离线和异步生命周期的顺序修复 21 个发现。词库原始内容没有改动。

## 第一批：进度、学习入口和发布安全

| 编号 | 原问题 | 修复后的行为 | 主要实现 |
| --- | --- | --- | --- |
| WA-01 | 多个窗口用各自旧快照覆盖整份进度 | 同一词库只有一个可写窗口；其他窗口可查词、导出；原窗口退出或转入后台后自动交接；恢复写权限前重读最新进度 | `src/store/writer.ts`、`src/store/store.ts`、`src/App.tsx` |
| WA-02 | 错误的内层备份版本被清洗为空数据并覆盖现有记录 | 导入前完整校验版本、词库和记录；先保存导入前恢复副本；写入失败保留或回滚旧记录，损坏数据不能悄悄变成空备份 | `src/store/store.ts`、`src/pages/Me.tsx` |
| WA-03 | 词条加载失败后一直转圈，加载期间快捷键仍能推进 | 当前题单独显示加载、错误及重试；加载未完成不能答题或推进；迟到请求不覆盖新题 | `src/atlas/entry-request.ts`、`src/atlas/context.tsx`、`src/pages/Learn.tsx` |
| WA-04 | 新索引与旧缓存分块混用 | 生产构建生成带内容摘要的分块和清单；按清单 URL 与 SRI 验证加载，再核对整块 ID、词形和数量；失败可重试 | `scripts/atlas-release.ts`、`src/atlas/release.ts`、`src/atlas/data.ts` |
| WA-05 | 搜索或词条弹窗打开后，数字键、Enter、空格仍影响背后学习页 | 弹窗独占相关输入；页面快捷键尊重已处理事件、编辑控件、修饰键和按钮原生行为 | `src/lib/shortcuts.ts`、`src/pages/Learn.tsx` |
| WA-19 | 缺少 forge 输入时编译脚本先写坏公开词库 | 全部输入先验证；完整暂存输出通过一致性检查后再替换；普通提交失败回滚，回滚失败保留恢复材料 | `scripts/atlas/build_atlas.py`、`scripts/output_transaction.py` |
| WA-20 | 导出目录指向源项目祖先时，可能删除项目和其他文件 | 拒绝源目录、祖先、子目录、符号链接和无法识别的非空目录；扫描、验证暂存结果后替换，保留目标 `.git` | `scripts/package_public.py`、`scripts/output_transaction.py` |

### 保存失败与兼容性

进度写入失败后保留内存中的内容，能够导出；重试成功后才清除错误。设置的待保存修改也会保留，重试时与最新已保存设置合并。如果后台窗口还有未保存进度，而另一个窗口已写入更新，则进入明确的冲突状态：保留两份数据，禁止旧快照继续覆盖。用户应先导出本窗口备份，再刷新并选择要恢复的记录。

学习写入需要支持 Web Locks 的浏览器，并使用 HTTPS 或 localhost。API 缺失或协调失败时保持只读，仍可查词、调整设置和导出已有进度。没有采用会过期的 localStorage/IndexedDB 租约模拟互斥，因为暂停的旧窗口恢复后仍可能越过租约期限写入。

首次升级到此修复版时，应关闭并重新打开旧版本页面，使所有学习窗口都采用新的写入协调规则。

## 第二批：计划、词形、练习与分享

| 编号 | 原问题 | 修复后的行为 | 主要实现 |
| --- | --- | --- | --- |
| WA-07 | 今日计划不会随着卡片到期或跨午夜更新 | 计划、日期、每日额度、连续天数、每日一词和星图共用时间戳；到期、午夜、分钟边界及恢复前台时刷新；开始时再读最新进度 | `src/lib/today-clock.ts`、`src/pages/Today.tsx`、`src/store/session.ts` |
| WA-08 | `so` 错匹配 `soup` 等派生词前缀 | 先找完整词头，再匹配有限的明确屈折形式；短语保持完整；找不到时沿用释义回退 | `src/lib/text.ts` |
| WA-09 | `cheque/check` 被作为唯一的字面答案 | 展示词头与接受答案分开；`cheque`、`check` 均正确；首选词形用于提示，反馈按实际合法答案的长度显示 | `src/lib/text.ts`、`src/pages/Learn.tsx`、`src/pages/Practice.tsx` |
| WA-10 | 号称完整候选池抽样，实际只能抽前 60 个 | 对完整来源去重并随机抽最多 10 个；学习路线仍遵守原有前 400 个符合等级词的规则 | `src/lib/practice.ts`、`src/pages/Practice.tsx` |
| WA-11 | 260 毫秒过渡期重复完成，重复累计成绩 | 同步锁定已完成题目；迟到输入、重复推进不能重复计分；暂停保留输入并排除后台时间；保存成功后才显示本轮完成 | `src/lib/practice.ts`、`src/pages/Practice.tsx` |
| WA-15 | 分享卡把最多 9 张预览图当成总词数 | 统计全部不重复词条，九宫格只限制插画数量；20 词会显示 20，重试题不重复计数 | `src/ui/shareSession.ts` |

额外修正了回归中发现的边界：取消尚在加载的“再来一轮”后迟到请求不再反跳；WPM 输出与现有 `0–400` 持久化范围一致，快速多字符输入不再产生刷新后消失的记录；切换词库会重置旧练习实例，同一词库切到后台仍保留当前输入。

首次 CI 还暴露了提示计数与输入文本分两次更新的间隙。补充复现确认，提示后立即提交可能按旧的“未提示”状态给分。现在输入值与提示计数在同一个操作中更新，提交显式携带当前提示状态；回归检查每次提示后的文本与焦点、自由编辑和清空、立即提交使用最新输入，以及提示后的正确答案按 Hard（2）而非 Easy（4）记分。

真实词库扫描覆盖 **7,298 个词头、14,596 条例句**。新的规则全部可定位，修正了旧规则的 `so → soup`、`employee → Employers`、`monarch → monarchy` 三处错误定位。该扫描验证的是定位结果，不替代词条语义和插画内容的人工审校。

## 第三批：离线、音频与异步清理

| 编号 | 原问题 | 修复后的行为 | 主要实现 |
| --- | --- | --- | --- |
| WA-06 | 第一次访问没有预缓存应用外壳，注册还要等完整 load | 启动时注册；构建生成带摘要的完整外壳清单；安装完整成功后才激活；补缓存首次接管前已使用的资源 | `scripts/offline-release.ts`、`src/lib/offline.ts`、`public/sw.js`、`src/main.tsx` |
| WA-12 | 迟到的环境声加载覆盖新选择，关闭后仍播放 | 每次选择有独立代次；只允许最后一次仍有效的选择创建音源 | `src/lib/sound.ts` |
| WA-13 | 声音加载失败被永久缓存，恢复网络后仍无声 | 失败请求从缓存移除；并发请求仍合并；下一次调用要求刷新运行时缓存，避免反复解码同一份坏的 200 响应 | `src/lib/sound.ts`、`public/sw.js` |
| WA-14 | 旧发音结束时恢复音量，破坏新发音的背景压低 | 音量恢复绑定当前播放代次；停止立即结算播放；先绑定结束、暂停与错误事件；TTS 取消不依赖平台补发结束事件 | `src/lib/audio.ts` |
| WA-16 | 音频带 Range 请求时绕过缓存，离线无法播放 | 缓存完整 200 音频，再按合法单范围切出 206；支持开放范围、后缀范围与 416；不把 206 当完整文件保存 | `public/sw.js` |
| WA-17 | 激活时删除同域其他应用缓存 | 按应用 scope 与内容版本命名；只查询、清理本 scope 管理的缓存；保留其他应用、其他路径及无法证明归属的旧缓存 | `public/sw.js` |
| WA-18 | 星图退出后，350 毫秒迟到回调又打开词条 | 新点选取消旧选择；卸载、布局或模式变化清理定时器；只由当前有效引擎打开词条 | `src/galaxy/Galaxy.tsx` |
| WA-21 | 文档说 raw 可选，生成脚本却直接取值而崩溃 | 缺失、null 或空数组均可；非法类型在读取凭据和提交任务前拒绝；新增只校验输入的命令 | `scripts/atlas/gen_text.py` |

同一发音按钮连续点击时，也使用请求代次保护按钮的播放状态，旧请求结束不能清除新请求的状态。

新 Service Worker 采用默认等待更新的生命周期；旧控制页退出后才激活新版本，避免在进行中的练习下替换外壳和清除旧缓存。离线保证以成功安装的外壳和已经完整缓存的资源为边界，未访问、未完成下载或已被浏览器清理的媒体不在保证范围内。部署细节见 [deployment.md](deployment.md)。

## 验证与复现

常规检查：

```bash
npm ci
npm test
npm run test:pipeline
npm run check:atlas
npm run build
```

浏览器回归使用独立的临时服务器和新浏览器上下文，不连接用户的浏览器或线上学习进度：

```bash
npx playwright install --with-deps chromium
npm run test:e2e -- --output output/e2e-regressions.json
npm run test:e2e:storage -- --output output/e2e-storage-failures.json
npm run test:e2e:offline -- --output output/e2e-offline.json
```

`test:e2e` 覆盖真实 UI、数据加载、词形、抽样、时钟、输入、星图和音频生命周期；`test:e2e:storage` 注入 localStorage 故障，检查恢复、导出和窗口交接；`test:e2e:offline` 使用生产构建和真实 Service Worker 验证首次访问、离线刷新、Range、scope 隔离和版本更新。

支持通过 `ATLAS_CHROMIUM_EXECUTABLE` 指向已有 Chromium；额外参数可用 `ATLAS_CHROMIUM_ARGS` JSON 数组提供，或用 `ATLAS_CHROMIUM_ARGS_MODULE` 载入提供 `args` 的运行环境模块。

### 本次验证范围

2026-10-26 的最终集成验证结果如下。浏览器为 Chromium 153.0.8010.0。

| 检查 | 结果 |
| --- | --- |
| `npm test` | 89 项通过，0 失败 |
| `npm run test:pipeline` | 29 项通过，0 失败 |
| 完整交互回归 | 20 个场景通过，无未捕获页面异常 |
| 存储失败回归 | 8 个场景通过，无未捕获页面异常 |
| 真实生产离线回归 | 7 个场景通过，无未捕获页面异常 |
| 最后补充的音频强制重取改动 | 音频重试浏览器场景单独复跑通过，并由音频和 SW 单元回归验证连接行为 |
| TypeScript 与生产构建 | `npm run build` 通过 |
| 完整 checkout 的 CI 资源检查 | `check:atlas` 通过，7,298 词、14,596 例句，媒体引用检查 0 错误 |
| 词形定位全量扫描 | 7,298 词、14,596 例句，0 条未定位，3 处旧误匹配修正 |
| 变更核对 | 原始 `public/atlas/` 和 `data/` 无修改；`git diff --check` 通过 |

开发环境采用精简检出：真实索引、73 个分块和源码完整；约 650 MB 的原始媒体没有全部下载。UI 测试对非核心媒体使用有效的固定资源，音频行为测试使用有效 WAV 与原生浏览器音频 API。生产离线测试使用真实词库和独立的最小媒体夹具。

`check:atlas` 的完整媒体存在性检查已由完整 checkout 的 CI 执行通过：7,298 个词条均有插画、英音、美音和基础例句音频，另有 1,011 个雅思例句音频引用，结构及媒体引用错误为 0。原校验器还会输出 24 条非阻塞的词头匹配提示，逐条核对均为 `draw → drew`、`run → ran` 等不规则词形；新的词形定位扫描能够正确识别。

完整媒体检查验证的是引用和文件存在性；没有逐一人工试听全部音频，也没有把 Chromium 结果当作 Safari/iOS 真机验收。

新增的 `Check` workflow 执行上述完整检查。`Deploy to GitHub Pages` 仅手动触发且限定 main，通过检查后才部署；创建本修复 PR 本身不会触发站点发布。
