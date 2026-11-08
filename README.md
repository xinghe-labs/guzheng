# 「孤证」数一数独立信源

很多网站在说同一件事——但它们是各自求证，还是在互相搬运？贴进一句话，
这里会全网检索、逐页抓取原文、把重复内容合并归簇，数一数真正**互相独立**的信源。

- 结论三档：**多源印证**（≥2 处独立源）/ **孤证**（仅 1 处）/ **查无对证**（0 处）
- 结论只回答「几个源头」，不判断真假
- 内核基于开源项目 [easy-websearch](https://github.com/xinghe-labs/easy-websearch)

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

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/xinghe-labs/guzheng)

一键 Render 部署；Cloudflare Pages / GitHub Pages + Actions 等更多方案见 [DEPLOY.md](DEPLOY.md)。
