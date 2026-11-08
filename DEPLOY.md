# 部署指南

四种免费方案，都能绑定你自己的域名。**推荐顺序：Cloudflare Workers（前端+后端一体，一条命令）→ Render（完整体验）→ GitHub Pages（零第三方账号）→ Fly.io**。

---

## 方案一：Cloudflare Workers 一键部署（推荐，约 2 分钟）

> 前端 + 后端一体：静态 assets 与 Worker 同仓库同域名，免费、无需信用卡、永不休眠。

**部署**：

```bash
npm install
npx wrangler login        # 浏览器授权一次
npx wrangler deploy       # 输出 https://guzheng.<你的子域>.workers.dev
```

**绑定域名**：Cloudflare Dashboard → Workers & Pages → guzheng → **Settings → Domains & Routes → Add → Custom domain**（域名 DNS 也在 CF 时自动配好，HTTPS 自动签发）。

> 免费档为什么跑得动：每请求 CPU 限 10ms——本产品把耗时全放在搜索/抓取的**网络等待**上（不计 CPU），门过滤+聚类实际计算远低于限额（本地 workerd 全链路实测无超限告警）；每请求最多 50 个子请求，实际用 25–35。
> 已知边界：Workers 无持久文件缓存（isolate 内存缓存 24h，重启即清）；云端机房在海外，中文主力引擎为搜狗系（实测海外出口正常），bing 在数据中心 IP 偶发反爬垃圾页——核内门自动过滤不计入来源，属预期。
> 更新版本：改完代码再跑一次 `npx wrangler deploy` 即可。

---

## 方案二：Render 一键部署（完整 Node 后端，约 3 分钟）

> 完整后端 + 前端一体，访客提交后 20–90 秒出结果，免费档无需信用卡。

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

## 方案三：GitHub Pages + Actions（零第三方账号，全免费）

**角色**：Pages 当前端；Actions 当异步计算后端（公开仓库 Actions 免费无限额度）。
**代价**：结果不是实时的——每次检查要手动跑一次 workflow，1–3 分钟后前端回放。

1. Fork / 推送本仓库到 GitHub，进入仓库 **Settings → Pages**：
   Source 选 **Deploy from a branch**，分支 `main`、目录 `/ (root)`，保存。
   （仓库根已有 `.nojekyll`，静态文件原样发布。）
2. 跑一次检查：仓库 **Actions → check-claim → Run workflow** → 输入一句话 → Run。
3. 跑完后 workflow 把结果写入 `results/<id>.json` 并自动重新发布 Pages。
   打开 `https://<你>.github.io/<仓库>/?result=<id>` 查看结论（id 显示在 workflow 的 Summary 里）。
4. 域名：Settings → Pages → **Custom domain** 填你的域名，DNS 加 CNAME 指向 `<你>.github.io`。

> 适合自托管/个人核查存档：每条结果都留在仓库里，`results/index.jsonl` 是全部检查史。

---

## 方案四：Fly.io（CLI 本地直推，不依赖 GitHub）

```bash
fly auth signup                 # 需绑信用卡（不扣费）
fly launch --no-deploy          # 读 fly.toml
fly deploy
fly certs add 你的域名           # 按提示加 DNS 记录
```

---

## 通用说明

- **引擎直连**：云端没有本地代理，搜索全部直连；某引擎被风控时内核自动降级到可用引擎。
- **缓存**：Workers 为 isolate 内存缓存（重启即清，24h TTL）；容器版写在临时目录；Actions 版每次全新跑。
- **防滥用**：Workers 同时最多 2 个检查（超出 429）；容器版 2–3 个 + 排队；公开站点建议前置 Cloudflare 限流。
- **HTTPS**：以上平台自定义域名的证书全部自动签发。

## 已知边界（上线前请读）

- 结论只回答「几个独立源头」，**不判断真假**——产品页方法说明与页脚免责声明已写明。
- 搜索引擎覆盖面决定下限：中文小众声明可能「查无对证」，不代表不存在。
- 搜狗等引擎偶尔风控掉线，内核有冷却救援与多引擎冗余，但极端情况下独立源计数可能偏低。
