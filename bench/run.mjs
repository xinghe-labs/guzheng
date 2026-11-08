#!/usr/bin/env node
// 基准跑分：逐条跑 countSources，对比期望档位
// 硬指标：hard claim（无 soft 标记）全对才算通过；soft 单独列出供人工复核
import { countSources } from "../core/lib/count.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const claims = JSON.parse(readFileSync(path.join(here, "claims.json"), "utf8"));
const only = process.argv[2]; // 可传序号（如 "3"）或区间（如 "1-15"）只跑部分
const inRange = (n) => {
  if (!only) return true;
  const m = only.match(/^(\d+)-(\d+)$/);
  if (m) return n >= +m[1] && n <= +m[2];
  return String(n) === only;
};

const rows = [];
for (let i = 0; i < claims.length; i++) {
  const c = claims[i];
  if (!inRange(i + 1)) continue;
  if (i > 0 && !only) await new Promise((res) => setTimeout(res, 20000)); // 间隔，避免把 bing/sogou 打进冷却
  process.stderr.write(`[${i + 1}/${claims.length}] ${c.claim}\n`);
  let r;
  try {
    r = await countSources(c.claim, { noCache: process.argv.includes("--fresh") });
  } catch (e) {
    rows.push({ n: i + 1, claim: c.claim, expect: c.expect, soft: !!c.soft, got: "ERROR", err: String(e.message || e).slice(0, 150) });
    continue;
  }
  const pass = r.verdict === c.expect;
  rows.push({
    n: i + 1, claim: c.claim, expect: c.expect, soft: !!c.soft, got: r.verdict,
    pass, sources: r.independentSources, relevant: r.relevant, fetched: r.fetchedOk,
    notFetched: r.notFetched.length, offtopic: r.offtopic.length,
    domains: r.clusters.flatMap((cl) => cl.domains).slice(0, 6),
    secs: +(r.timings.totalMs / 1000).toFixed(1),
  });
}

const hard = rows.filter((r) => !r.soft);
const passN = hard.filter((r) => r.pass).length;
console.log("\n===== 结果 =====");
for (const r of rows) {
  const mark = r.pass ? "✓" : "✗";
  console.log(`${mark} #${r.n} [期望 ${r.expect} / 实际 ${r.got}，独立源${r.sources}] ${r.soft ? "(soft)" : ""} ${r.claim}`);
  if (!r.pass) console.log(`    域名: ${(r.domains || []).join(", ")} | 相关${r.relevant} 抓取${r.fetched} 失败${r.notFetched} 不相关${r.offtopic} | ${r.secs}s ${r.err || ""}`);
}
console.log(`\n硬案例: ${passN}/${hard.length} 通过${hard.length && passN === hard.length ? " ✅" : " ❌"}`);
writeFileSync(path.join(here, "results.json"), JSON.stringify(rows, null, 2));
process.exit(passN === hard.length ? 0 : 1);
