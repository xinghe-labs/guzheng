// 「孤证」Workers 抓取层：直连 fetch + HTML→正文文本；失败回退 r.jina.ai reader（免费无 key）。
// 返回结构与 lib/count.mjs 的 fetchOne 约定一致：{ ok, url, title?, content?, error? }。

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_CHARS = 9000;

// ---------- HTML → 正文文本 ----------
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

export function htmlToText(html) {
  let t = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|template|form|select|button)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, " ");
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? decodeEntities(titleM[1]).replace(/\s+/g, " ").trim() : undefined;
  // 块级标签换行，保留句子边界（core 的句级过滤按 。！？!?\n 切句）
  t = t.replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|blockquote|td|th)[^>]*>/gi, "\n");
  t = decodeEntities(t.replace(/<[^>]*>/g, " "));
  t = t.replace(/[ \t\r\f]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return { title, text: t.slice(0, MAX_CHARS) };
}

function looksEmpty(text) {
  // 反爬空壳（“访问验证”“开启JavaScript”）与正文太短都视为失败
  if (!text || text.length < 500) return true;
  return /请开启.{0,6}JavaScript|访问验证|安全验证|人机验证|Just a moment|Enable JavaScript/i.test(text.slice(0, 600));
}

// ---------- 抓取 ----------
async function directFetch(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      "accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "referer": "https://www.bing.com/",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    cf: { cacheTtl: 3600, cacheEverything: false },
  }).catch((e) => { throw new Error(e.name === "TimeoutError" ? "timeout" : String(e.message || e).slice(0, 120)); });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml|text\/plain|application\/json/i.test(ct)) throw new Error(`non-HTML content-type: ${ct.split(";")[0]}`);
  const html = await res.text();
  const { title, text } = htmlToText(html);
  if (looksEmpty(text)) throw new Error("empty/anti-bot shell page");
  return { ok: true, url, title, content: text };
}

// r.jina.ai reader：免费无 key，抓直连失败（403/429/JS 渲染壳）的页面
async function jinaFetch(url) {
  const res = await fetch("https://r.jina.ai/" + url, {
    headers: { "user-agent": UA, accept: "text/plain" },
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => { throw new Error("jina: " + (e.name === "TimeoutError" ? "timeout" : String(e.message || e).slice(0, 100))); });
  if (!res.ok) throw new Error(`jina HTTP ${res.status}`);
  let text = await res.text();
  // jina 返回 "Title: ...\nURL Source: ...\n\nMarkdown Body" 形态，抽正文
  const titleM = text.match(/^Title:\s*(.+)$/m);
  text = text.replace(/^Title:.*$/m, "").replace(/^URL Source:.*$/m, "").replace(/^Markdown Content:\s*/m, "").trim();
  if (!text || text.length < 500) throw new Error("jina empty body");
  return { ok: true, url, title: titleM?.[1]?.trim(), content: text.slice(0, MAX_CHARS) };
}

export async function fetchPage(url) {
  try {
    return await directFetch(url);
  } catch (e1) {
    try {
      return await jinaFetch(url);
    } catch (e2) {
      return { ok: false, url, error: (e2.message || "").startsWith("jina:") ? e2.message : `direct(${e1.message}) + jina(${e2.message})` };
    }
  }
}
