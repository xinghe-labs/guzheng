# 部署指南

三种免费方案，都能绑定你自己的域名。**推荐顺序：Render（完整体验）→ Cloudflare Pages（静态最稳）→ GitHub Pages（零第三方账号）**。

---

## 方案一：Render 一键部署（推荐，约 3 分钟）

> 完整后端 + 前端一体，访客提交后 20–90 秒出结果，支持自定义域名、免费 HTTPS。

**一键部署**（登录 Render 后点按钮，选你的 GitHub 仓库即可）：

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/xinghe-labs/guzheng)

**手动部署**：

1. 注册 [render.com](https://render.com)（邮箱即可，免费档无需信用卡）。
2. 把本仓库 Fork 或推送到你的 GitHub。
3. Dashboard → **New + → Blueprint** → 选择仓库 → Render 自动读取 `render.yaml` → **Apply**。
4. 部署完成后得到 `https://guzheng-xxxx.onrender.com`，直接可用。

**绑定域名**：Service → Settings → **Custom Domains** → Add Domain → 输入你的域名 → 按提示在 DNS 加一条 CNAME（指向 Render 给的地址）→ 证书自动签发。

> 免费档冷启动：15 分钟无访问会休眠，首次唤醒约 30 秒。检查一次约 20–90 秒。

---

## 方案二：Cloudflare Pages（前端）+ Render 后端

> 前端托管在 Cloudflare 边缘网络（全球 CDN、永不休眠）；重活由方案一的后端承担。

1. 注册 [dash.cloudflare.com](https://dash.cloudflare.com)。
2. **Workers & Pages → Create → Pages → Connect to Git** → 选同一个 GitHub 仓库。
3. 构建配置：构建命令**留空**，构建输出目录填 `/`（纯静态，无构建步骤）→ Save and Deploy。
4. 得到 `https://<项目名>.pages.dev`，页面本身已可用。
5. **连接后端**：打开站点 → 页脚「后端端点」→ 填 Render 后端地址（如 `https://guzheng-xxxx.onrender.com`）→ 保存。
   - 分享链接也可以直接带参数：`https://你的域名/?api=https://guzheng-xxxx.onrender.com`

**绑定域名**：Pages 项目 → **Custom domains** → Set up a custom domain → 域名 DNS 托管在 Cloudflare 时自动配 CNAME，否则按提示手动加。

> 为什么 Cloudflare Workers 免费档不能直接当后端：完整内核要抓取约 12 个页面并做指纹聚类，CPU 时间超过 Workers 免费档 10ms 限制，所以 Cloudflare 承担前端 + CDN，后端交给 Render/Fly。

---

## 方案三：GitHub Pages + Actions（零第三方账号，全免费）

> 前端用 GitHub Pages，计算用 GitHub Actions（公开仓库免费无限额度）。代价：结果异步——每次检查手动触发一次 workflow，1–3 分钟后在前端回放结果。

1. Fork / 推送本仓库到 GitHub（**公开**仓库）。
2. 仓库 **Settings → Pages** → Source 选 **Deploy from a branch** → 分支 `main`、目录 `/ (root)` → Save。（仓库已含 `.nojekyll`，静态文件原样发布。）
3. 跑一次检查：仓库 **Actions → check-claim → Run workflow** → 输入一句话 → Run workflow。
4. 跑完后结果已写入 `results/<id>.json` 并自动重新发布 Pages；id 见 workflow 运行页的 Summary。
5. 查看：`https://<用户名>.github.io/<仓库名>/?result=<id>`

**绑定域名**：Settings → Pages → Custom domain → 填域名 → DNS 加 CNAME 指向 `<用户名>.github.io` → 勾选 Enforce HTTPS。

> 方案三适合个人核查存档：每条结果永久留在仓库里，`results/index.jsonl` 是全部检查史。

---

## 备选：Fly.io / 任意 Docker 平台

```bash
fly auth signup        # 需绑卡（不扣费）
fly launch --no-deploy # 读 fly.toml
fly deploy
fly certs add 你的域名  # 按提示加 DNS
```

任意能跑 Docker 的平台（Railway、Koyeb、自己的 VPS）：直接用仓库根的 `Dockerfile`。

---

## 通用说明

- **引擎直连**：云端没有本地代理，搜索全部直连；某引擎被风控时内核自动降级到可用引擎。
- **缓存**：容器版写在临时目录（重启即清，24h TTL）；Actions 版每次全新跑。
- **防滥用**：后端同时最多 2–3 个检查，超出排队/429；公开站点建议前置 Cloudflare 限流。
- **本地开发**：`npm install && npm start`；如需代理跑搜索，`GUZHENG_PROXY=http://127.0.0.1:10808 npm start`。

## 已知边界（上线前请读）

- 结论只回答「几个独立源头」，**不判断真假**——产品页方法说明与页脚免责声明已写明。
- 搜索引擎覆盖面决定下限：中文小众声明可能「查无对证」，不代表不存在。
- 搜狗等引擎偶尔风控掉线，内核有冷却救援与多引擎冗余，但极端情况下独立源计数可能偏低。
