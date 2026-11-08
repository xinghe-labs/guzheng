// 「孤证」Workers 搜索层：纯 fetch 移植自 easy-websearch 的引擎实现（MIT, xinghe-labs）。
// Node 版用子进程 + 文件冷却表；Workers 无子进程/持久缓存，改为全引擎并行 + allSettled 自然降级。
// 返回结构与 lib/core.mjs 的 searchAll 约定一致：{ results, engines, searchMs }。

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ENGINE_TIMEOUT = 15_000;

// ---------- cookie jar（isolate 级） ----------
// bing/sogou 对无 cookie 的首次请求会给保守/降级 SERP（如“长期熬夜…”只回词典页），
// 与 easy-websearch 原版的 cookieHeader/storeCookies 同构移植。
const cookieJar = new Map(); // host -> "a=b; c=d"
function cookieHeader(host) { return cookieJar.get(host) || ""; }
function storeCookies(host, res) {
  const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (!sc.length) return;
  const cur = new Map();
  const prev = cookieJar.get(host);
  if (prev) for (const p of prev.split("; ")) { const i = p.indexOf("="); if (i > 0) cur.set(p.slice(0, i), p.slice(i + 1)); }
  for (const c of sc) {
    const [pair, ...attrs] = c.split(";");
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim(), val = pair.slice(i + 1).trim();
    if (attrs.some((a) => /expires=Thu, 01 Jan 1970/i.test(a))) { cur.delete(name); continue; }
    cur.set(name, val);
  }
  if (cur.size) cookieJar.set(host, [...cur].map(([k, v]) => k + "=" + v).join("; "));
}

// ---------- 基础请求 ----------
export async function fetchText(url, { method = "GET", headers = {}, body, timeout = ENGINE_TIMEOUT, redirect = "follow" } = {}) {
  const host = new URL(url).hostname;
  // 默认浏览器头（原版同源）；引擎特有 header 可覆盖
  const outgoing = {
    "user-agent": UA,
    "accept": "text/html,application/json;q=0.9,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    ...headers,
  };
  if (!outgoing.cookie && cookieHeader(host)) outgoing.cookie = cookieHeader(host);
  const res = await fetch(url, {
    method, headers: outgoing, body, redirect,
    signal: AbortSignal.timeout(timeout),
  }).catch((e) => { throw new Error(e.name === "TimeoutError" ? "timeout" : String(e.message || e).slice(0, 120)); });
  storeCookies(host, res);
  const out = { status: res.status, body: "", finalUrl: res.url };
  if (method !== "HEAD") out.body = await res.text().catch(() => "");
  return out;
}

const RETRYABLE = /timeout|HTTP [45]\d\d|ECONNRESET|ENOTFOUND|network/;
async function retryFetch(url, opts = {}) {
  try {
    return await fetchText(url, opts);
  } catch (err) {
    if (opts.method === "POST" || !RETRYABLE.test(err.message)) throw err;
    await new Promise((r) => setTimeout(r, 500));
    return fetchText(url, opts);
  }
}

// baidu /link 等包装跳转：manual redirect 拿 location，最多 2 跳
async function resolveRedirect(url, timeout = ENGINE_TIMEOUT) {
  let cur = url;
  for (let i = 0; i < 2; i++) {
    const { status } = await fetchText(cur, { redirect: "manual", timeout });
    if ([301, 302, 303, 307, 308].includes(status)) {
      const { headers } = await fetch(cur, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeout) }).catch(() => ({ headers: null }));
      const loc = headers?.get?.("location");
      if (loc && /^https?:\/\//.test(loc)) { cur = loc; continue; }
    }
    break;
  }
  return cur;
}

// ---------- 文本工具（与 easy-websearch 同源） ----------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", zwnj: "", zwj: "", middot: "·", mdash: "—", ndash: "–", hellip: "…", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", copy: "©", "#39": "'", "#x27": "'" };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, e) => {
    if (ENTITIES[e]) return ENTITIES[e];
    if (e[0] === "#") {
      const num = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : m;
    }
    return m;
  });
}
const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

function parseJson(body) {
  try { return JSON.parse(body); } catch (e) { throw new Error(`invalid JSON response: ${e.message}`); }
}

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of [...x.searchParams.keys()])
      if (/^(utm_|ref|fbclid)/i.test(k)) x.searchParams.delete(k);
    let s = x.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch { return u; }
}

function snippetAfter(body, from, len = 200) {
  const chunk = body.slice(from, from + 700);
  return stripTags(chunk).slice(0, len);
}

// Bing bot-junk guard（同源移植）
function looksLikeJunk(results, query) {
  if (results.length < 2) return false;
  const hostOf = (r) => { try { return new URL(r.url).hostname.replace(/^www\./, ""); } catch { return r.url; } };
  const pathOf = (r) => { try { return new URL(r.url).pathname; } catch { return null; } };
  const hosts = new Set(results.map(hostOf));
  if (results.length >= 3 && hosts.size === 1) return true;
  const rootCount = results.filter((r) => ["", "/"].includes(pathOf(r))).length;
  if (results.length >= 2 && rootCount >= Math.ceil(results.length * 0.8)) return true;
  const words = query.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g);
  if (words && words.length) {
    const anyHit = results.some((r) => {
      const hay = `${r.title} ${r.url} ${r.snippet}`.toLowerCase();
      return words.some((w) => hay.includes(w));
    });
    if (!anyHit) return true;
  }
  return false;
}

// ---------- HTML 网页引擎 ----------
async function engineDDG(ctx) {
  const params = new URLSearchParams({ q: ctx.query, nost: "1", kl: "cn-zh" });
  const { status, body } = await fetchText("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const results = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of body.matchAll(re)) {
    if (results.length >= ctx.n * 2) break;
    let href = decodeEntities(m[1]);
    const ud = href.match(/[?&]uddg=([^&]+)/);
    if (ud) href = decodeURIComponent(ud[1]);
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//.test(href)) continue;
    results.push({ title, url: href, snippet: "" });
  }
  const snRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let i = 0;
  for (const s of body.matchAll(snRe)) {
    if (i >= results.length) break;
    results[i++].snippet = stripTags(s[1]);
  }
  if (results.length === 0 && /anomaly|challenge|captcha/i.test(body)) throw new Error("blocked (anomaly page)");
  if (results.length === 0) throw new Error("no results parsed");
  return results;
}

async function engineBing(ctx) {
  const params = new URLSearchParams({ q: ctx.query, mkt: "zh-CN", setlang: "zh" });
  const { status, body } = await retryFetch(`https://www.bing.com/search?${params}`, {
    headers: { referer: "https://www.bing.com/", "upgrade-insecure-requests": "1" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const results = [];
  const liRe = /<li class="b_algo"[\s\S]*?<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>([\s\S]*?)<\/li>/g;
  for (const m of body.matchAll(liRe)) {
    if (results.length >= ctx.n * 2) break;
    let url = decodeEntities(m[1]);
    const u = url.match(/[?&]u=a1?([A-Za-z0-9+/=]+)/);
    if (u) {
      try {
        const decoded = atob(u[1].replace(/-/g, "+").replace(/_/g, "/"));
        if (/^https?:\/\//.test(decoded)) url = decoded;
      } catch { /* keep the redirect URL */ }
    }
    const title = stripTags(m[2]);
    const snip = stripTags(m[3]).slice(0, 400);
    if (!/^https?:\/\//.test(url) || !title) continue;
    results.push({ title, url, snippet: snip });
  }
  if (results.length === 0) throw new Error("no results parsed");
  if (looksLikeJunk(results, ctx.query)) throw new Error("bot junk detected (results unrelated to query)");
  return results;
}

async function engineBaidu(ctx) {
  const params = new URLSearchParams({ wd: ctx.query, rn: String(ctx.n) });
  const { status, body } = await retryFetch("https://www.baidu.com/s?" + params.toString(), {
    headers: { referer: "https://www.baidu.com/" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  if (body.includes("百度安全验证") || body.includes("wappass")) throw new Error("baidu anti-bot page (security verification)");
  const results = [];
  const re = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of body.matchAll(re)) {
    if (results.length >= ctx.n * 2) break;
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//.test(m[1])) continue;
    results.push({ title, url: decodeEntities(m[1]), snippet: "" });
  }
  if (results.length === 0) throw new Error("no results parsed");
  if (looksLikeJunk(results, ctx.query)) throw new Error("bot junk detected (results unrelated to query)");
  const tops = results.slice(0, ctx.n);
  const resolved = await Promise.all(tops.map((r) => resolveRedirect(r.url).catch(() => r.url)));
  tops.forEach((r, i) => { r.url = resolved[i]; });
  return tops;
}

async function engineSogouWeb(ctx) {
  const params = new URLSearchParams({ query: ctx.query });
  const { status, body } = await retryFetch("https://www.sogou.com/web?" + params.toString(), {
    headers: { referer: "https://www.sogou.com/" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  if (/antispider|验证码|seccode/i.test(body)) throw new Error("sogou anti-bot page (captcha) — retry later");
  const results = [];
  const re = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of body.matchAll(re)) {
    if (results.length >= ctx.n * 2) break;
    const title = stripTags(m[2]);
    if (!title) continue;
    results.push({ title, url: decodeEntities(m[1]), snippet: snippetAfter(body, m.index + m[0].length) });
  }
  if (results.length === 0) throw new Error("no results parsed");
  const tops = results.slice(0, ctx.n);
  const urls = await Promise.all(tops.map(async (r) => {
    if (!r.url.startsWith("/link")) return r.url;
    try {
      const full = new URL(r.url, "https://www.sogou.com").toString();
      const { body: stub } = await fetchText(full, { timeout: 4000 });
      let target = "";
      for (const m of stub.matchAll(/url\s*\+=\s*'([^']*)'/g)) target += m[1];
      target = target.replace(/@.*$/, "");
      if (/^https?:\/\//.test(target)) return target;
      const alt = stub.match(/window\.location\.replace\("([^"]+)"\)/);
      if (alt && /^https?:\/\//.test(alt[1])) return alt[1];
    } catch { /* keep the /link URL */ }
    return r.url;
  }));
  tops.forEach((r, i) => { r.url = urls[i]; });
  return tops;
}

async function engineSo360(ctx) {
  const params = new URLSearchParams({ q: ctx.query });
  const { status, body } = await fetchText("https://www.so.com/s?" + params.toString(), {
    headers: { referer: "https://www.so.com/" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  if (/验证码|wappass/i.test(body)) throw new Error("so360 anti-bot page (captcha) — retry later");
  const results = [];
  const re = /<h3[^>]*class="res-title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of body.matchAll(re)) {
    if (results.length >= ctx.n * 2) break;
    const title = stripTags(m[2]);
    if (!title) continue;
    const desc = body.slice(m.index, m.index + 900).match(/<p class="res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    results.push({ title, url: decodeEntities(m[1]), snippet: desc ? stripTags(desc[1]).slice(0, 300) : "" });
  }
  if (results.length === 0) throw new Error("no results parsed");
  const tops = results.slice(0, ctx.n);
  const urls = await Promise.all(tops.map(async (r) => {
    if (!/so\.com\/link/.test(r.url)) return r.url;
    try {
      const { body: stub } = await fetchText(r.url, { timeout: 4000 });
      const m = stub.match(/window\.location\.replace\("([^"]+)"\)/) ||
                stub.match(/window\.location\.href\s*=\s*"([^"]+)"/) ||
                stub.match(/URL='([^']+)'/);
      if (m && /^https?:\/\//.test(m[1])) return m[1];
    } catch { /* keep the wrapper URL */ }
    return r.url;
  }));
  tops.forEach((r, i) => { r.url = urls[i]; });
  return tops;
}

// ---------- 官方 keyless API 引擎 ----------
async function engineWikipedia(ctx) {
  const cjk = /[\u4e00-\u9fa5]/.test(ctx.query);
  const lang = cjk ? "zh" : "en";
  const params = new URLSearchParams({ action: "query", list: "search", srsearch: ctx.query, format: "json", srlimit: String(Math.min(ctx.n, 10)) });
  const { status, body } = await retryFetch(`https://${lang}.wikipedia.org/w/api.php?${params}`, {
    timeout: Math.max(ENGINE_TIMEOUT * 1.5, 12000), headers: { accept: "application/json" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.query?.search || [];
  return items.map((r) => ({
    title: r.title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, "_"))}`,
    snippet: stripTags(r.snippet || ""),
  }));
}

async function engineHn(ctx) {
  const params = new URLSearchParams({ query: ctx.query, hitsPerPage: String(Math.min(ctx.n, 10)) });
  const { status, body } = await retryFetch(`https://hn.algolia.com/api/v1/search?${params}`, { headers: { accept: "application/json" } });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const hits = parseJson(body)?.hits || [];
  return hits.filter((r) => r.title).map((r) => ({
    title: r.title,
    url: r.url || `https://news.ycombinator.com/item?id=${r.objectID}`,
    snippet: stripTags(r.story_text || r.comment_text || "").slice(0, 300),
  }));
}

async function engineGithub(ctx) {
  const params = new URLSearchParams({ q: ctx.query, per_page: String(Math.min(ctx.n, 10)) });
  const { status, body } = await retryFetch(`https://api.github.com/search/repositories?${params}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (status === 403) throw new Error("GitHub rate limit (10 searches/min unauthenticated)");
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.items || [];
  return items.map((r) => ({
    title: `${r.full_name} ⭐${r.stargazers_count ?? 0}`,
    url: r.html_url,
    snippet: (r.description || "").slice(0, 300),
  }));
}

async function engineJuejin(ctx) {
  const params = new URLSearchParams({ query: ctx.query, id_type: "0", cursor: "0", limit: String(Math.min(ctx.n, 10)) });
  const { status, body } = await fetchText(`https://api.juejin.cn/search_api/v1/search?${params}`, { headers: { accept: "application/json" } });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const d = parseJson(body);
  if (d.err_no !== 0) throw new Error(d.err_msg || `err_no ${d.err_no}`);
  const out = [];
  for (const item of d.data || []) {
    const info = item.result_model?.article_info;
    if (!info?.title) continue;
    out.push({
      title: info.title,
      url: `https://juejin.cn/post/${item.result_model.article_id}`,
      snippet: (info.brief_content || "").slice(0, 300),
    });
    if (out.length >= ctx.n) break;
  }
  return out;
}

async function engineCSDN(ctx) {
  const params = new URLSearchParams({ q: ctx.query, t: "blog", p: "1" });
  const { status, body } = await fetchText(`https://so.csdn.net/api/v3/search?${params}`, {
    headers: { accept: "application/json", referer: "https://www.csdn.net/" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.result_vos || [];
  return items.slice(0, ctx.n).filter((r) => r.url && r.title).map((r) => ({
    title: stripTags(r.title),
    url: r.url,
    snippet: stripTags(r.description || "").slice(0, 300),
  }));
}

async function engineArxiv(ctx) {
  const params = new URLSearchParams({ search_query: `all:${ctx.query}`, max_results: String(Math.min(ctx.n, 10)) });
  const { status, body } = await fetchText(`https://export.arxiv.org/api/query?${params}`);
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const out = [];
  for (const m of body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1];
    const title = stripTags((entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const id = (entry.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || "";
    const summary = stripTags((entry.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || "");
    if (!title || !id.startsWith("http")) continue;
    out.push({ title, url: id.replace("http://", "https://"), snippet: summary.slice(0, 300) });
  }
  return out;
}

async function engineMwmbl(ctx) {
  const { status, body } = await retryFetch(`https://api.mwmbl.org/api/v1/search/?s=${encodeURIComponent(ctx.query)}`, { headers: { accept: "application/json" } });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body) || [];
  return items.slice(0, ctx.n).filter((r) => r.url).map((r) => ({
    title: (r.title || []).map((f) => f.value).join("") || r.url,
    url: r.url,
    snippet: (r.extract || []).map((f) => f.value).join("").slice(0, 300),
  }));
}

// ---------- 融合（与 core.countFromSources 的约定同构） ----------
const ENGINES = {
  bing: engineBing, sogouweb: engineSogouWeb, baidu: engineBaidu, so360: engineSo360, ddg: engineDDG, mwmbl: engineMwmbl,
  wikipedia: engineWikipedia, github: engineGithub, juejin: engineJuejin, csdn: engineCSDN, hn: engineHn, arxiv: engineArxiv,
};

export async function searchAll(query, { n = 12 } = {}) {
  const t0 = Date.now();
  const ctx = { query, n, timeout: ENGINE_TIMEOUT };
  const names = Object.keys(ENGINES);
  const settled = await Promise.all(names.map(async (name) => {
    const ms0 = Date.now();
    try {
      const items = await ENGINES[name](ctx);
      return { name, ok: true, count: items.length, ms: Date.now() - ms0, items };
    } catch (e) {
      return { name, ok: false, count: 0, ms: Date.now() - ms0, error: String(e.message || e).slice(0, 100), items: [] };
    }
  }));

  // 融合：normUrl 去重，多引擎命中的结果 engines 取并集
  const byUrl = new Map();
  for (const s of settled) {
    if (!s.ok) continue;
    for (const item of s.items) {
      const key = normalizeUrl(item.url);
      if (!byUrl.has(key)) byUrl.set(key, { title: item.title, url: item.url, snippet: item.snippet || "", engines: new Set([s.name]) });
      else byUrl.get(key).engines.add(s.name);
    }
  }
  return {
    results: [...byUrl.values()],
    engines: settled.map(({ name, ok, count, ms, error }) => ({ name, ok, count, ms, error })),
    searchMs: Date.now() - t0,
  };
}
