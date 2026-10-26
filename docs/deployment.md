# 部署 / Deployment

`npm run build` 先执行 TypeScript 检查，再生成完整静态站点 `dist/`。部署这一目录的全部内容即可。已有公开词库的前端构建不需要内容生成服务的凭据，也不需要 `.local/forge/`。

## 环境、校验与路径

CI 使用 Node.js 24、Python 3.13 和 Chromium。Python 仅用于离线的内容管道回归；网站运行不依赖 Python。

```bash
npm ci
npm test
npm run test:pipeline
npm run check:atlas
npm run build
```

`check:atlas` 会检查索引声明的真实插画、缩略图和音频是否存在。请使用包含这些文件的完整工作树。稀疏检出或只下载代码的目录可能通过单元测试和构建，但不能据此声称完整媒体校验通过；不要用空文件或修改媒体标志绕过发布校验。

默认部署路径为 `/`。项目站点或反向代理子路径需要在构建时设置带结尾斜杠的 `ATLAS_BASE`：

```bash
ATLAS_BASE=/words/ npm run build
ATLAS_BASE=/words/ npm run preview
```

随后访问 `http://localhost:5188/words/`。页面使用 hash 路由，例如 `/words/#/learn`；资源请求失败应返回真实的 404，不应把 `index.html` 当作 JSON、脚本或音频返回。

### HTTPS 与多窗口保存

正式站点使用 HTTPS；本机开发和预览可通过 `localhost` 或 `127.0.0.1` 访问。进度编辑依赖浏览器的 [Web Locks API](https://www.w3.org/TR/web-locks/)。普通局域网 HTTP 地址以及缺少该 API 的浏览器会进入只读模式，仍可浏览和导出已有进度。请勿依靠关闭浏览器安全限制来提供正常学习功能。

同一来源、同一词库只有一个窗口可写。其他窗口等待接管；写入窗口隐藏或关闭后释放锁，接管者先重新读取最新进度。未保存内容与另一窗口的新进度冲突时，页面保留本窗口的内存数据并提示导出；先导出，再刷新并选择需要恢复的记录。

localStorage 按来源隔离。更换域名、端口或 HTTP/HTTPS 协议前，请在旧地址导出备份，再到新地址导入。子路径变化也会改变 Service Worker 的缓存范围。

## 构建版本与发布顺序

构建插件会生成两层发布信息：

- `dist/atlas/index.json` 引用带 SHA-256 文件名和完整性信息的词条分块，例如 `atlas/entries/0.<sha256>.json`。读取时校验内容与索引，不会把旧分块当作新分块。
- `dist/offline-manifest.json` 和 `dist/sw.js` 描述这一版完整页面资源。发布版本还包含插画、音频和音效的摘要；仅修改媒体也会产生新版本，但不会因此预先下载全部媒体。

每次先在独立目录完成构建与校验，再以完整目录或平台部署产物切换站点。自行托管时，可用版本目录加原子切换的符号链接；不要一边服务用户，一边逐个覆盖正在使用的 `index.html`、索引和分块文件。

旧窗口可能仍引用旧的哈希文件。可控制文件保留策略的托管环境应保留这些历史文件，覆盖旧页面的使用期限。GitHub Pages 的标准产物替换不保证保留上一版文件：发布后，如果旧窗口请求尚未缓存的旧分块出现加载错误，先导出未保存进度，关闭该站点的所有窗口后重新打开。内容校验会报错和提供重试，不会接受错版内容。

### 缓存策略

| 文件 | 建议的 HTTP 缓存策略 |
| --- | --- |
| `index.html`、`sw.js`、`atlas/index.json`、`offline-manifest.json`、`manifest.webmanifest` | `Cache-Control: no-cache`，每次使用前重新验证 |
| Vite 生成的 `assets/` 哈希资源、`atlas/entries/<n>.<sha256>.json` | `public, max-age=31536000, immutable`；同一 URL 的内容不再修改 |
| 使用稳定名称的插画、缩略图、音频、音效、品牌图片和图标 | `no-cache`；更正内容后重新构建发布 |

客户端按站点范围和构建版本隔离缓存。HTTP/CDN 缓存策略仍需要正确配置，不能对整个目录统一设置长时间缓存。

### Nginx 子路径示例

将 `dist/` 的内容放到 `/srv/www/words/`，以下配置置于已经配置好 HTTPS 和 MIME 类型的 `server` 中：

```nginx
root /srv/www;

location = /words {
    return 308 /words/;
}

location = /words/ {
    try_files /words/index.html =404;
    add_header Cache-Control "no-cache";
}

location ~ "^/words/(assets/|atlas/entries/[0-9]+\.[a-f0-9]{64}\.json$)" {
    try_files $uri =404;
    add_header Cache-Control "public, max-age=31536000, immutable";
}

location /words/ {
    try_files $uri =404;
    add_header Cache-Control "no-cache";
}
```

更换部署目录时，保持上面的 URL 与构建时的 `ATLAS_BASE` 一致。静态主机应支持完整音频的 200 响应和正常的字节范围请求。

## 首次访问、离线与升级

Service Worker 只在生产构建中注册，`npm run dev` 不启用它。首次联网打开时会预缓存页面、词库索引、manifest、图标，以及构建得到的 JS、CSS、字体和品牌图片。安装会校验这些文件的完整性；其中任一文件不完整都会使这一版安装失败，保留原有工作版本。

页面显示出来不等于离线准备已完成。请等待首次安装和后台缓存完成后再断网；开发者可以在浏览器的 Application / Service Workers、Cache Storage 面板检查。首次取得页面控制权前已经请求的词条和媒体会尝试补入缓存，晚完成的请求也会被收集。

离线能力的边界如下：

- 页面界面和词库索引由首次预缓存提供。词条分块、插画、缩略图、音频和音效按访问情况缓存；从未缓存的内容仍需要网络。
- 音频缓存保存完整响应，再为播放器提供字节范围响应；不会把只收到的一段 206 响应当作完整音频缓存。
- 媒体运行时缓存最多保留 1,500 个资源条目，另受浏览器存储配额与清理策略影响。该数值按文件计算，不按单词计算。
- 新版本使用独立缓存。激活后只清理本应用当前范围内可识别的旧版本缓存；不会清理其他应用或其他部署路径的缓存。旧 `atlas-v1` 缓存不再读取。
- 升级后，旧版运行时媒体缓存不会冒充新版数据；尚未缓存到新版本的词条或媒体可能需要重新联网加载。

更新遵循浏览器的等待生命周期，不会在正在学习时强制接管。新版本下载完成后，关闭该站点所有标签页和窗口（包括独立 PWA 窗口），再重新打开，才能可靠地完成激活。仅刷新仍可能继续使用旧 worker。更新等待不影响当前窗口继续保存学习进度。

## GitHub Actions 与 Pages

[`check.yml`](../.github/workflows/check.yml) 在主分支推送、PR 和手动运行时执行：`npm ci`、TypeScript 单元测试、Python 离线回归、完整词库与媒体检查、TypeScript/生产构建，以及交互、存储失败、离线升级三组 Chromium 回归。浏览器证据以工作流产物保存 7 天。PR 检查只有 `contents: read` 权限，不部署。

[`pages.yml`](../.github/workflows/pages.yml) 只接受手动触发，且只允许 `main` 分支。使用步骤：

1. 在仓库 **Settings → Pages** 将来源设为 **GitHub Actions**。
2. 确认待发布修改已经合入 `main`。
3. 在 **Actions → Deploy to GitHub Pages → Run workflow** 选择 `main` 并运行。
4. 构建任务再次完成全部校验，读取 Pages 的实际子路径，再上传 `dist/`。独立部署任务使用 `github-pages` 环境发布这一产物。

构建任务仅有 `contents: read` 和读取 Pages 配置的权限；只有部署任务拥有 `pages: write`、`id-token: write`。工作流不会自动创建或启用 Pages，也不需要个人访问令牌。可按仓库需要在 `github-pages` 环境设置部署分支和人工审批规则。

动作版本根据 2026-10-26 的官方发布核对：[checkout](https://github.com/actions/checkout/releases)、[setup-node](https://github.com/actions/setup-node/releases)、[setup-python](https://github.com/actions/setup-python/releases) 和 [upload-artifact](https://github.com/actions/upload-artifact/releases) 使用 v7；[configure-pages](https://github.com/actions/configure-pages/releases) 使用 v6；[upload-pages-artifact](https://github.com/actions/upload-pages-artifact/releases) 和 [deploy-pages](https://github.com/actions/deploy-pages/releases) 使用 v5。工作流结构参考 [GitHub Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)；文档示例版本可能落后于动作发布。
