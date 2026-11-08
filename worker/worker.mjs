// 「孤证」Cloudflare Workers 入口：/api/check 同步接口 + /results/<id> 内存回放 + 静态 assets。
// 核心逻辑复用 lib/core.mjs（与 Node 版同源）；搜索/抓取用 worker/ 纯 fetch 实现。
import { countFromSources, normUrl } from "../lib/core.mjs";
import { searchAll } from "./search.mjs";
import { fetchPage } from "./fetcher.mjs";

// isolate 级内存缓存（重启即清，TTL 24h；Workers 免费档足够）
const TTL_MS = 24 * 3600 * 1000;
const claims = new Map(); // sha1 -> { ts, data }
const pages = new Map();  // normUrl -> { ts, data }
let inflight = 0;
const MAX_INFLIGHT = 2;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (req, status, obj) => new Response(JSON.stringify(obj, null, 2), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", ...CORS },
});

// 兼容 Node 全局（nodejs_compat 下直接可用；兜底以防 compat 变更）
import { createHash } from "node:crypto";
const sha1 = (s) => createHash("sha1").update(s).digest("hex");

function cacheGet(map, key) {
  const e = map.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > TTL_MS) { map.delete(key); return null; }
  return e.data;
}
function cachePut(map, key, data) {
  // 简单上限：超 300 条丢弃最旧（免费档内存保守计）
  if (map.size > 300) {
    const oldest = [...map.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) map.delete(oldest[0]);
  }
  map.set(key, { ts: Date.now(), data });
}

async function check(req, url) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const claim = (url.searchParams.get("claim") || "").trim();
  const t0 = Date.now();
  if (claim.length < 4 || claim.length > 200) return json(req, 400, { error: "claim 参数需在 4–200 字符之间" });

  const rid = sha1(claim).slice(0, 10);
  const hit = cacheGet(claims, rid);
  if (hit) return json(req, 200, { ...hit, cached: true, rid });

  if (inflight >= MAX_INFLIGHT) return json(req, 429, { error: "当前检查并发已满（同时最多 2 个），请稍后重试" });
  inflight++;
  try {
    const data = await countFromSources(claim, {
      top: 12,
      t0,
      searchAll: (q) => searchAll(q, { n: 12 }),
      fetchOne: async (u) => {
        const key = normUrl(u);
        const ph = cacheGet(pages, key);
        if (ph) return { ...ph, cached: true };
        const d = await fetchPage(u);
        if (d.ok) cachePut(pages, key, d);
        return d;
      },
    });
    cachePut(claims, rid, data);
    return json(req, 200, { ...data, rid });
  } finally {
    inflight--;
  }
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/check") return await check(req, url);
      if (url.pathname === "/healthz") return json(req, 200, { ok: true, inflight, claims: claims.size });
      // 结果回放：rid = sha1(claim) 前 10 位，前端 ?result=<id> 直连内存缓存
      const mResult = url.pathname.match(/^\/results\/([a-f0-9]{10})\.json$/);
      if (mResult) {
        const hit = cacheGet(claims, mResult[1]);
        if (!hit) return json(req, 404, { error: "找不到结果（Workers 内存缓存重启即清；异步回放请用 GitHub Pages 版）" });
        return json(req, 200, hit);
      }
      return json(req, 404, { error: "not found" });
    } catch (e) {
      return json(req, 500, { error: String(e.message || e).slice(0, 200) });
    }
  },
};
