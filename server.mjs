#!/usr/bin/env node
// 「孤证」API 服务 —— 单文件、零框架（node 原生 http），可直接跑在 Render/Fly 等免费容器平台
// 路由：
//   GET /                     → 产品页 index.html
//   GET /api/check?claim=...  → 数源结论 JSON（CORS: *）
//   GET /healthz              → 探活
// 并发保护：同时最多 3 个真实检查，另 5 个排队，超出返回 429；
//           单请求总时限 180s（含排队），超时返回 504。
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countSources } from "./lib/count.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 3);
const MAX_QUEUE = 5;
const REQUEST_DEADLINE_MS = 180_000;

const INDEX_HTML = path.join(__dirname, "index.html");

// ---------- 简易信号量 ----------
let active = 0;
const waiters = [];
async function acquire() {
  if (active < MAX_CONCURRENT) { active++; return; }
  await new Promise((res) => waiters.push(res));
  active++;
}
function release() {
  active--;
  const w = waiters.shift();
  if (w) { active++; w(); }
}

function sendJson(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleCheck(req, res, u) {
  const claim = (u.searchParams.get("claim") || "").trim();
  const fresh = u.searchParams.get("fresh") === "1";
  if (claim.length < 4 || claim.length > 200) {
    return sendJson(res, 400, { error: "claim 长度需在 4–200 字符之间" });
  }

  const arrived = Date.now();
  const queued = active >= MAX_CONCURRENT;
  if (queued && waiters.length >= MAX_QUEUE) {
    return sendJson(res, 429, { error: "当前检查的人太多，请半分钟后再试" });
  }
  await acquire();
  try {
    const left = REQUEST_DEADLINE_MS - (Date.now() - arrived);
    if (left <= 0) return sendJson(res, 504, { error: "排队超时，请稍后重试" });
    let timedOut = false;
    const timer = sleep(left).then(() => { timedOut = true; });
    const result = await Promise.race([
      countSources(claim, { noCache: fresh }),
      timer,
    ]);
    if (timedOut || !result) {
      return sendJson(res, 504, { error: "检查超时（全网检索通常 20–90 秒，这次太久），请重试" });
    }
    // 对外只发 UI 需要的字段：正文不留存、不上报（offtopic/notFetched 仅含 url/标题/原因，无正文）
    const pub = {
      claim: result.claim,
      verdict: result.verdict,
      independentSources: result.independentSources,
      totalResults: result.totalResults,
      relevant: result.relevant,
      clusters: result.clusters,
      offtopic: result.offtopic,
      notFetched: result.notFetched,
      skippedUrls: result.skippedUrls,
      engines: result.engines,
      timings: result.timings,
      cached: !!result.cached,
    };
    sendJson(res, 200, pub, { "Access-Control-Allow-Origin": "*" });
  } catch (e) {
    sendJson(res, 500, { error: "内核执行出错：" + String(e?.message || e).slice(0, 200) });
  } finally {
    release();
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (u.pathname === "/api/check") return await handleCheck(req, res, u);
    if (u.pathname === "/healthz") return sendJson(res, 200, { ok: true });
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }
    if (u.pathname === "/" || u.pathname === "/index.html") {
      const html = await readFile(INDEX_HTML, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(html);
    }
    // 结果回放文件（GitHub Actions 异步检查通道的结果落盘；GH Pages 静态托管时自带，此处为本地/容器等价物）
    const mResult = u.pathname.match(/^\/results\/([a-f0-9]{6,40})\.json$/);
    if (mResult) {
      const file = path.join(__dirname, "results", mResult[1] + ".json"); // 文件名已由正则限定为 hex，无穿越风险
      const body = await readFile(file, "utf8");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
      return res.end(body);
    }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    sendJson(res, 500, { error: String(e?.message || e).slice(0, 200) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[guzheng] listening on http://${HOST}:${PORT}`);
});
