#!/usr/bin/env node
// 「孤证」数源内核 v0.1
// 流程：双路搜索（代理+直连）→ 合并去重 → 并行抓取 Top N（带 24h 缓存）
//      → 相关性过滤 → 5-gram shingle 转载聚类 → 独立源计数
// 输出三档结论：multi（多独立源）/ single（孤证）/ none（查不到）
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function normUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const k of [...u.searchParams.keys()])
      if (/^(utm_|fbclid|spm|from|fr$|ie$)/i.test(k)) u.searchParams.delete(k);
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch { return raw; }
}

function domainOf(raw) {
  try { return new URL(raw).hostname.replace(/^www\./, ""); } catch { return "(bad-url)"; }
}

// 中文按字 bigram + 英文单词，作为 claim 的关键词集
function claimKeywords(claim) {
  const cleaned = claim.replace(/[\s\p{P}\p{S}]+/gu, "");
  const zh = [...cleaned].filter((c) => /[\u4e00-\u9fff]/.test(c));
  const bigrams = new Set();
  const trigrams = [];
  for (let i = 0; i < zh.length - 1; i++) bigrams.add(zh[i] + zh[i + 1]);
  for (let i = 0; i < zh.length - 2; i++) trigrams.push(zh[i] + zh[i + 1] + zh[i + 2]);
  const en = new Set((claim.toLowerCase().match(/[a-z0-9]{2,}/g) || []));
  return { bigrams, en, trigrams, total: bigrams.size + en.size };
}

function coverage(text, kw) {
  if (kw.total === 0) return 0;
  let hit = 0;
  for (const b of kw.bigrams) if (text.includes(b)) hit++;
  for (const w of kw.en) if (text.toLowerCase().includes(w)) hit++;
  return hit / kw.total;
}

// 三元组覆盖率：垃圾页即使常见词碰巧命中，也很难凑出 claim 里的三元组（如“心血管”）
function trigramCoverage(text, trigrams) {
  if (!trigrams.length) return null; // claim 太短无三组时跳过该项
  let hit = 0;
  for (const t of trigrams) if (text.includes(t)) hit++;
  return hit / trigrams.length;
}

function bestExcerpt(text, kw, maxLen = 300) {
  const sents = text.split(/(?<=[。！？!?\n])/).map((s) => s.trim()).filter((s) => s.length > 15);
  const scored = sents.map((s) => [s, coverage(s, kw) + (sentenceTri(s, kw.trigrams) || 0)]);
  scored.sort((a, b) => b[1] - a[1]);
  // 目录页套话（医生列表、站点导航）覆盖分容易虚高，不作为摘录；
  // 论断句（含表明/研究/风险/将…）加分优先；同片段重复 ≥2 次的句子也是名单页特征
  const BOILER = /^(擅长|简介|首页|医生|专家|预约|挂号|出诊|电话|地址|Copyright|©|http|www)/i;
  const ASSERT = /(表明|研究|显示|结果|导致|增加|降低|风险|将|宣布|发布|成立|迁|收购|可能|反而|更有)/;
  const isBoiler = (s) => BOILER.test(s) || /(.{6,12})\1/.test(s.replace(/\s/g, ""));
  const scored2 = scored.map(([s, sc]) => [s, sc + (ASSERT.test(s) ? 0.15 : 0)]).sort((a, b) => b[1] - a[1]);
  let out = "";
  for (const [s, sc] of scored2) {
    if (sc <= 0) break;
    if (isBoiler(s)) continue;
    if (out.length + s.length > maxLen) break;
    out += s;
  }
  if (!out) for (const [s, sc] of scored) { if (sc <= 0) break; if (out.length + s.length > maxLen) break; out += s; }
  return out || "(无直接相关句子)";
}

// 全文最高句级三元组覆盖率：页面算独立源的前提是存在一句同时说出 claim 核心词组的话
function sentenceTri(text, trigrams) {
  if (!trigrams || !trigrams.length) return null;
  const sents = text.split(/(?<=[。！？!?\n])/);
  let best = 0;
  for (const s of sents) {
    let hit = 0;
    for (const t of trigrams) if (s.includes(t)) hit++;
    const c = hit / trigrams.length;
    if (c > best) best = c;
  }
  return best;
}

function bestSentenceCov(text, kw) {
  const sents = text.split(/(?<=[。！？!?\n])/);
  let best = 0;  for (const s of sents) {
    const c = coverage(s, kw);
    if (c > best) best = c;
  }
  return best;
}

// 5-gram 字符 shingle 集合
function shingles(text, k = 5) {
  const t = text.replace(/\s+/g, "");
  const set = new Set();
  for (let i = 0; i <= t.length - k; i++) set.add(t.slice(i, i + k));
  return set;
}

function containment(a, b) {
  if (!a.size || !b.size) return 0;
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  let hit = 0;
  for (const x of s) if (l.has(x)) hit++;
  return hit / s.size;
}

class UF {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) { this.p[this.find(a)] = this.find(b); }
}

// 主语抽取：仅当断言是“实体 + 年份/事件词”结构（健康类断言自动跳过）；
// 去掉大学/集团等通用后缀得到核心实体（复旦大学→复旦），用于最佳匹配句的主语绑定
function claimSubject(claim) {
  const m = claim.match(/^(.{2,12}?)(?=20\d{2}|将|已|宣布|正式|成功|定于)/);
  if (!m) return null;
  const core = m[1].replace(/(大学|学院|附属医院|医院|集团|公司|机场|研究院|研究所|中心)+$/u, "");
  return core.length >= 2 ? core : null;
}

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
      const key = normUrl(item.url);
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
  const cacheFile = path.join(CACHE_DIR, "fetch", sha1(normUrl(url)) + ".json");
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
  const GATE_V = "v8"; // v8: 主语绑定（最佳匹配句必须含主语核心实体）
  const claimCache = path.join(CACHE_DIR, "claims", sha1(claim) + "-" + GATE_V + ".json");
  if (!noCache) {
    try {
      const j = JSON.parse(await fs.readFile(claimCache, "utf8"));
      if (Date.now() - j.ts < FETCH_TTL_MS) return { ...j.data, cached: true };
    } catch {}
  }
  const kw = claimKeywords(claim);
  const search = await searchAll(claim);

  // 不该抓的链接 + 同域名限量 + 候选分层：
  // 通用网页引擎（bing/sogou/ddg等）的结果优先，社区站内搜索（juejin/csdn/hn）松散匹配会污染候选，垫底补位
  const WEB_ENGINES = new Set(["bing", "ddg", "sogouweb", "sogouwechat", "baidu", "so360", "mwmbl", "brave", "startpage", "mojeek", "searxng", "wikipedia", "pubmed"]);
  const SKIP = /(^|\.)(doi\.org|sogou\.com|so\.com|bing\.com|baidu\.com|google\.[a-z.]+)$/i;
  const notFetchedSkip = [];
  const perDomain = new Map();
  const candidates = [];
  const tryAdd = (c) => {
    if (candidates.length >= top) return;
    const d = domainOf(c.url);
    if (SKIP.test(d)) { notFetchedSkip.push({ url: c.url, title: c.title, reason: "搜索引擎垂直页/DOI，不作为来源" }); return; }
    if ((perDomain.get(d) || 0) >= 2) return;
    perDomain.set(d, (perDomain.get(d) || 0) + 1);
    candidates.push(c);
  };
  const isWeb = (c) => [...(c.engines instanceof Set ? c.engines : (c.engines || []))].some((e) => WEB_ENGINES.has(e));
  for (const c of search.results) if (isWeb(c)) tryAdd(c);
  for (const c of search.results) if (!isWeb(c)) tryAdd(c);
  const fetches = await Promise.all(candidates.map(async (c) => ({ c, f: await fetchOne(c.url) })));

  const pages = []; const notFetched = []; const offtopic = [];
  for (const { c, f } of fetches) {
    if (!f.ok || !f.content) { notFetched.push({ url: c.url, title: c.title, reason: f.error || "no content" }); continue; }
    const cov = coverage(f.content, kw);
    const sTri = sentenceTri(f.content, kw.trigrams);
    const sCov = bestSentenceCov(f.content, kw);
    // 精度门：句级三元组覆盖率（claim 太短无三元组时退回句级 bigram）。
    // 只看整页词覆盖会把“提及实体但没说这件事”的页面算进来。
    // 措辞变体救援：断言与页面措辞差异大时句三元组会漏（如“喝咖啡过多”vs“咖啡喝多了”），
    // 此时若整页覆盖和句双覆盖都高，也算相关；对照反例（juejin 代码页 cov≤0.27）仍被拦住。
    const gate = sTri !== null ? sTri : sCov;
    const gateThreshold = sTri !== null ? 0.20 : 0.5;
    const rescued = sTri !== null && gate < gateThreshold && cov >= 0.45 && sCov >= 0.30;
    // 关系硬信号（防“提实体没提事”误放行）：
    // 1) 传闻/辟谣词典：页面在讲“这只是传闻/已辟谣”就不是独立源
    // 2) 年份绑定：断言带 20XX 年，页面通篇没出现该年份则不算源（如“2026并购”命中 2017 虾米传闻旧文）
    // 3) 事件词绑定：断言含事件词（并购/更名/停产…）时页面必须出现同义事件词，实体共现不够（csdn 解锁工具页）
    const HEDGE = /(传闻|谣言|辟谣|假消息|纯属虚构|并不存在|没有发布|不实)/;
    const EVENT_SYN = {
      并购: ["并购", "收购", "合并", "兼并"], 更名: ["更名", "改名", "更名为"], 迁: ["迁"],
      停产: ["停产", "停售"], 成立: ["成立", "设立", "组建"], 开设: ["开设", "设立", "成立", "开办"],
    };
    const years = [...claim.matchAll(/(20\d{2})年?/g)].map((m) => m[1]);
    // 必须出现“YYYY年”（纯日期戳 2026/03/21 不算，那是更新时间不是事件年份）
    const yearMissing = years.length > 0 && !years.some((y) => f.content.includes(y + "年"));
    const hedged = HEDGE.test(f.content);
    const evKey = Object.keys(EVENT_SYN).find((k) => claim.includes(k));
    const evMissing = evKey ? !EVENT_SYN[evKey].some((w) => f.content.includes(w)) : false;
    // 标题双词救援：短问答页（“二手烟也会导致肺癌吗”）整页/句门都偏低但标题同时命中
    // ≥2 个断言二元词组且 cov/sCov 达底线，则放行（闲鱼/瓜子二手车类垃圾页标题一个都含不上）
    let titleHits = 0;
    const title = c.title || "";
    for (const b of kw.bigrams) if (title.includes(b)) titleHits++;
    const rescued2 = cov >= 0.20 && sCov >= 0.25 && titleHits >= 2;
    // 4) 主语绑定：断言主语实体必须出现在页面最佳匹配句里（防“同模板事件不同主体”：
    //    《北京这所大学2028年将整体搬迁》混进“复旦大学2028年迁苏州”）
    const subj = claimSubject(claim);
    let subjMissing = false;
    if (subj) {
      const sents = f.content.split(/(?<=[。！？!?\n])/).map((s) => s.trim()).filter((s) => s.length > 15);
      let bestS = "", bestSc = -1;
      for (const s of sents) {
        const sc = coverage(s, kw) + (sentenceTri(s, kw.trigrams) || 0);
        if (sc > bestSc) { bestSc = sc; bestS = s; }
      }
      subjMissing = bestSc > 0 && !bestS.includes(subj);
    }
    if ((cov < 0.30 && !rescued2) || (gate < gateThreshold && !rescued && !rescued2) || hedged || yearMissing || evMissing || subjMissing) {
      const reason = hedged ? "hedged(传闻/辟谣词汇)" : yearMissing ? "year-missing(页面无断言年份 " + years.join("/") + ")"
        : evMissing ? "event-missing(页面无事件词 " + evKey + "…)" : subjMissing ? "subject-missing(主语“" + subj + "”不在最佳句)" : "gate";
      offtopic.push({ url: c.url, title: c.title, cov: +cov.toFixed(2), sentTri: sTri === null ? null : +sTri.toFixed(2), sentCov: +sCov.toFixed(2), reason });
      continue;
    }
    pages.push({ url: c.url, domain: domainOf(c.url), title: c.title, content: f.content, excerpt: bestExcerpt(f.content, kw), cov: +cov.toFixed(2), sentTri: sTri === null ? null : +sTri.toFixed(2), engines: [...c.engines], cached: !!f.cached });
  }

  // 聚类：containment ≥ 0.75 或同 hostname 合并
  const sh = pages.map((p) => shingles(p.content));
  const uf = new UF(pages.length);
  const pairSims = [];
  for (let i = 0; i < pages.length; i++)
    for (let j = i + 1; j < pages.length; j++) {
      const sim = containment(sh[i], sh[j]);
      if (pages[i].domain === pages[j].domain) uf.union(i, j);
      else if (sim >= 0.75) { uf.union(i, j); pairSims.push([i, j, +sim.toFixed(2)]); }
    }
  const groups = new Map();
  pages.forEach((p, i) => {
    const g = uf.find(i);
    (groups.get(g) || groups.set(g, []).get(g)).push({ ...p, content: undefined });
  });
  const clusters = [...groups.values()].map((ps, i) => ({
    id: "c" + (i + 1),
    independentSource: true,
    domains: [...new Set(ps.map((p) => p.domain))],
    pages: ps,
    mergedBy: ps.length > 1 ? "content-similarity/同站" : "single",
  }));

  const n = clusters.length;
  const verdict = n === 0 ? "none" : n === 1 ? "single" : "multi";
  const result = {
    claim, verdict, independentSources: n,
    totalResults: search.results.length, fetchedOk: pages.length + offtopic.length,
    relevant: pages.length, notFetched: notFetched, skippedUrls: notFetchedSkip, offtopic, clusters,
    pairSims, engines: search.engines,
    timings: { searchMs: search.searchMs, totalMs: Date.now() - t0 },
  };
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
  const noCache = process.argv.includes("--no-cache");
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
