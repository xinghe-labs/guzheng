# 「孤证」数一数独立信源

很多网站在说同一件事——但它们是各自求证，还是在互相搬运？贴进一句话，
这里会全网检索、逐页抓取原文、把重复内容合并归簇，数一数真正**互相独立**的信源。

- 结论三档：**多源印证**（≥2 处独立源）/ **孤证**（仅 1 处）/ **查无对证**（0 处）
- 结论只回答「几个源头」，不判断真假
- 内核基于开源项目 [easy-websearch](https://github.com/xinghe-labs/easy-websearch)（Node 版直接复用其引擎；Cloudflare Workers 版为纯 fetch 同源移植，搜索/抓取/门过滤/聚类全部在边缘运行时完成）

## 网页一键部署（不用命令行）

点下面的按钮 → 登录/授权 → 自动拉取本仓库并部署，全程浏览器完成：

| 按钮 | 平台 | 说明 |
|---|---|---|
| [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xinghe-labs/guzheng) | Cloudflare Workers | 前端+后端一体，免费无需信用卡；完成后得到 `*.workers.dev` 域名，再在 Dashboard 绑自定义域名 |
| [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/xinghe-labs/guzheng) | Render | 完整 Node 后端，免费；免费档 15 分钟无访问休眠，首访唤醒约 30 秒 |

> Cloudflare 按钮首次点击会要求把仓库 Fork/连接到你的 CF 账号（部署所需），后续更新需在 CF Dashboard 里重新触发，或本地 `npx wrangler deploy`。自定义域名绑定步骤见 [DEPLOY.md](DEPLOY.md) 对应小节。

## 本地运行

```bash
npm install
npm start          # 默认 http://0.0.0.0:3000
```

仓库根即部署单元：`index.html`（产品页）+ `server.mjs`（API）+ `lib/count.mjs`（内核）。
静态平台（CF/GH Pages）可直接发布仓库根作为前端；`results/` + `.github/workflows/check.yml`
构成 GitHub Actions 异步检查通道。

可选环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `GUZHENG_CACHE` | `<系统临时目录>/guzheng-cache` | 抓取/结论缓存目录（24h） |
| `MAX_CONCURRENT` | `3` | 同时进行的真实检查数 |
| `GUZHENG_PROXY` | 空（直连） | 二路搜索的代理，本地开发可设 `http://127.0.0.1:10808`；云端留空 |

## API

```
GET /api/check?claim=<一句话>[&fresh=1]
```

返回：`{ verdict, independentSources, clusters[{domains,pages[{url,title,excerpt}]}], offtopic, engines, timings, cached }`
另有 `GET /healthz` 探活。CORS 全开。

## 部署（免费托管，只需提供域名）

### 方案一：Render 一键部署（后端前端一体，约 3 分钟）

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/xinghe-labs/guzheng)

点按钮 → 登录 Render → 选本仓库 → Apply，自动读 `render.yaml` 完成。免费档无需信用卡；
绑定域名：Service → Settings → Custom Domains → 按提示加 CNAME。

### 方案二：Cloudflare Pages（前端走全球 CDN，永不休眠）

前端托管在 Cloudflare，重活交给上面 Render 的后端，两步接入：

1. 注册 [dash.cloudflare.com](https://dash.cloudflare.com) → 左侧 **Workers & Pages** → **Create** → **Pages** 标签 → **Connect to Git** → 授权并选本仓库 → **Begin setup**。
2. 构建配置：**Framework preset 选 None**，**Build command 留空**，**Build output directory 填 `/`**（纯静态，无构建）→ Save and Deploy。
3. 一分钟后得到 `https://<项目名>.pages.dev`，页面已可访问。
4. **连接后端**：打开站点 → 页脚「后端端点」→ 填 Render 后端地址（如 `https://guzheng-xxxx.onrender.com`）→ 保存。
   分享链接也可直接带参数：`https://你的域名/?api=https://guzheng-xxxx.onrender.com`。
5. **绑定域名**：Pages 项目 → **Custom domains** → Set up a custom domain → 输入你的域名。
   域名 DNS 在 Cloudflare 托管时 CNAME 自动配好；不在 CF 就去你的 DNS 服务商加一条
   `<子域名> CNAME <项目名>.pages.dev`，回 CF 点刷新，证书自动签发。

> 为什么不直接用 CF Workers 当后端：完整内核要抓约 12 个页面并做指纹聚类，超过 Workers 免费档
> 10ms CPU 限制；所以 Cloudflare 承担前端 + CDN，后端交给 Render（或 Fly）。

### 方案三：GitHub Pages + Actions（零第三方账号，异步回放）

本仓库已开启：前端在 https://xinghe-labs.github.io/guzheng/ ，检查走 Actions（仓库 → Actions →
check-claim → Run workflow），结果写入 `results/` 后用 `?result=<id>` 回放（线上实例：
[?result=903c64933b](https://xinghe-labs.github.io/guzheng/?result=903c64933b)）。

三方案的域名绑定、Fly.io / Docker 等更多细节见 [DEPLOY.md](DEPLOY.md)。
