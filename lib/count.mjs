// 「孤证」Node 版内核壳：搜索/抓取走 easy-websearch 子进程 + 文件缓存，纯函数与编排复用 lib/core.mjs。
// CF Workers 版见 worker/（纯 fetch 实现，共用同一 core）。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countFromSources, GATE_V } from "./core.mjs";

const pExecFile = promisify(execFile);
const PKG = path.dirname(fileURLToPath(import.meta.resolve("easy-websearch/package.json")));
const SEARCH_MJS = path.join(PKG, "scripts", "search.mjs");
const FETCH_MJS = path.join(PKG, "scripts", "fetch.mjs");
const CACHE_DIR = process.env.GUZHENG_CACHE || path.join(tmpdir(), "guzheng-cache");
// 通用网页引擎（区别于社区站内搜索/学术库）；冷却救援判断用
const WEB_OK = new Set(["bing", "ddg", "sogouweb", "sogouwechat", "baidu", "so360", "mwmbl", "brave", "startpage", "mojeek", "searxng", "wikipedia", "pubmed"]);
const FETCH_TTL_MS = 24 * 3600 * 1000;
const PROXY = process.env.GUZHENG_PROXY || ""; // 本地开发可设 GUZHENG_PROXY=http://127.0.0.1:10808；云端留空直连

// ---------- 工具 ----------
const sha1 = (s) => createHash("sha1").update(s).digest("hex");

// ---------- 第 1 步：双路搜索 ----------
async function runSearch(query, { useProxy, noCooldown } = {}) {
  const env = {
    ...process.env,
    XDG_CACHE_HOME: CACHE_DIR,
    HTTPS_PROXY: useProxy ? PROXY : "",
    HTTP_PROXY: useProxy ? PROXY : "",
  };
  const args = [SEARCH_MJS, query, "--json", "-n", "12"];
  if (!useProxy) args.push("--direct");
  if (noCooldown) args.push("--no-cooldown");
  try {
    const { stdout } = await pExecFile(process.execPath, args, { env, timeout: 75_000, maxBuffer: 32e6 });
    return JSON.parse(stdout);
  } catch (e) {
    return { engines: [], results: [], error: String(e.message || e).slice(0, 200) };
  }
}

async function searchAll(claim) {
  const t0 = Date.now();
  // 直连优先；结果不够才补代理路由（实测两路引擎集重叠大，双路常态下纯浪费时间）
  const rounds = [await runSearch(claim, { useProxy: false })];
  if ((rounds[0].results || []).length < 8)
    rounds.push(await runSearch(claim, { useProxy: true }));
  // 冷却救援：无 key 可用的中文网页引擎只有 bing+sogouweb，任一进冷却召回就塌。
  // 有产出的网页引擎数 <2 时忽略冷却表强搜一轮（多花几秒，换回被冷却吞掉的引擎）。
  // 不能按结果数判断——bing 一家就能给10条，掩盖搜狗死亡。
  const webEngines = new Set();
  for (const r of rounds)
    for (const item of r.results || [])
      for (const e of item.engines || []) if (WEB_OK.has(e)) webEngines.add(e);
  if (webEngines.size < 2) rounds.push(await runSearch(claim, { useProxy: false, noCooldown: true }));
  const byUrl = new Map();
  for (const r of rounds) {
    for (const item of r.results || []) {
      const key = normUrlOf(item.url);
      if (!byUrl.has(key)) byUrl.set(key, { ...item, engines: new Set(item.engines || []) });
      else for (const e of item.engines || []) byUrl.get(key).engines.add(e);
    }
  }
  // 引擎去重（直连/代理重复报）：同 name 合并
  const engMap = new Map();
  for (const r of rounds)
    for (const e of r.engines || []) {
      const prev = engMap.get(e.name);
      engMap.set(e.name, prev ? { ...e, ok: e.ok || prev.ok, count: Math.max(e.count, prev.count), ms: Math.min(e.ms, prev.ms) } : e);
    }
  return { results: [...byUrl.values()], engines: [...engMap.values()], searchMs: Date.now() - t0 };
}

// searchAll 内部的 URL 归一用 core 的 normUrl（避免旧逻辑漂移）
import { normUrl as normUrlOf } from "./core.mjs";

// ---------- 第 2 步：抓取（直连失败→代理重试，带 24h 缓存） ----------
async function fetchOnce(url, { viaProxy }) {
  const env = {
    ...process.env,
    XDG_CACHE_HOME: CACHE_DIR,
    HTTPS_PROXY: viaProxy ? PROXY : "",
    HTTP_PROXY: viaProxy ? PROXY : "",
  };
  const { stdout } = await pExecFile(process.execPath, [FETCH_MJS, url, "--json", "--max-chars", "9000"],
    { env, timeout: viaProxy ? 35_000 : 25_000, maxBuffer: 32e6 });
  return JSON.parse(stdout);
}

async function fetchOne(url) {
  const cacheFile = path.join(CACHE_DIR, "fetch", sha1(normUrlOf(url)) + ".json");
  try {
    const j = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    if (Date.now() - j.ts < FETCH_TTL_MS) return { ...j.data, cached: true };
  } catch {}
  // 回退链：直连 → 代理（注意：ok:false 不是异常，也要继续试代理）
  let data = null, lastErr = "";
  for (const viaProxy of [false, true]) {
    try {
      const d = await fetchOnce(url, { viaProxy });
      if (d && d.ok) { data = d; break; }
      lastErr = (d && d.error) || lastErr;
    } catch (e) { lastErr = String(e.message || e).slice(0, 120); }
  }
  if (!data || !data.ok) return { ok: false, url, error: data?.error || lastErr || "all fetch paths failed" };
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify({ ts: Date.now(), data }));
  return data;
}

// ---------- 主流程 ----------
export async function countSources(claim, { top = 12, noCache = false } = {}) {
  const t0 = Date.now();
  // claim 级缓存（24h）：重复查询直接回放，引擎不被反复打；跑分重跑也靠它稳定
  // GATE_V：相关性门逻辑版本，门逻辑变更时 bump，旧缓存自动失效
  const claimCache = path.join(CACHE_DIR, "claims", sha1(claim) + "-" + GATE_V + ".json");
  if (!noCache) {
    try {
      const j = JSON.parse(await fs.readFile(claimCache, "utf8"));
      if (Date.now() - j.ts < FETCH_TTL_MS) return { ...j.data, cached: true };
    } catch {}
  }
  const result = await countFromSources(claim, { searchAll, fetchOne, top, t0 });
  try {
    await fs.mkdir(path.dirname(claimCache), { recursive: true });
    await fs.writeFile(claimCache, JSON.stringify({ ts: Date.now(), data: result }));
  } catch {}
  return result;
}

// ---------- CLI ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const claim = process.argv[2];
  const asJson = process.argv.includes("--json");
  const noCache = process.argv.includes("--no-cache") || process.argv.includes("--fresh");
  if (!claim) { console.error('用法: node count.mjs "<claim>" [--json] [--no-cache]'); process.exit(1); }
  const r = await countSources(claim, { noCache });
  if (asJson) console.log(JSON.stringify(r, null, 2));
  else {
    const label = { multi: "多独立源", single: "孤证", none: "查不到" }[r.verdict];
    console.log(`claim: ${r.claim}`);
    console.log(`结论: ${label}（独立源 ${r.independentSources} 个）`);
    console.log(`搜索 ${r.totalResults} 条 → 抓取 ${r.fetchedOk} → 相关 ${r.relevant}（不相关 ${r.offtopic.length}，抓取失败 ${r.notFetched.length}）`);
    for (const c of r.clusters) {
      console.log(`[${c.id}] ${c.pages.length} 页: ${c.domains.join(", ")}`);
      for (const p of c.pages) console.log(`    - ${p.title?.slice(0, 60)} | ${p.url.slice(0, 90)}`);
      if (c.pages[0]?.excerpt) console.log(`    摘: ${c.pages[0].excerpt.slice(0, 120)}`);
    }
    for (const nf of r.notFetched) console.log(`[抓取失败] ${nf.reason || ""} | ${nf.url.slice(0, 80)}`);
    for (const ot of r.offtopic) console.log(`[不相关] cov=${ot.cov} sentTri=${ot.sentTri} sentCov=${ot.sentCov} | ${(ot.title || "").slice(0, 40)} | ${ot.url.slice(0, 70)}`);
    const okEng = r.engines.filter((e) => e.ok).map((e) => `${e.name}(${e.count})`);
    console.log(`引擎: ${okEng.join(" ")} | 搜索 ${(r.timings.searchMs / 1000).toFixed(1)}s`);
    console.log(`耗时 ${(r.timings.totalMs / 1000).toFixed(1)}s`);
  }
}
