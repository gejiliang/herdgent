#!/usr/bin/env node
// 把汇总结果渲染成一页可直接看的对比报告。
//
//   node bench/report-html.mjs > /tmp/bench-report.html
//
// 【这一页只负责呈现，不负责判断】。所有数字来自 report.mjs 的汇总，
// 该标 `~` 的（n=1）照标，该说「分不出」的地方就写分不出 ——
// 报告好看不是目的，让人一眼看出「哪些差异是真的、哪些落在噪声里」才是。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

const { stdout } = await exec("node", [join(HERE, "report.mjs"), "--json"], {
  maxBuffer: 32 * 1024 * 1024,
});
const { summary, droppedInfra, totalRuns } = JSON.parse(stdout);

const HARNESS_ORDER = ["claude", "codex", "opencode", "pi", "kimi"];
const TASKS = [
  { id: "review-baseline", kind: "review", tier: "基线", label: "评审 · 基线", sub: "ollama#9379 · 该报 5 · 纯 Diff Level" },
  { id: "review-spread", kind: "review", tier: "分化", label: "评审 · 分化", sub: "SDL#12964 · 该报 7 · 2 条要跨仓库" },
  { id: "review-hard", kind: "review", tier: "难", label: "评审 · 难", sub: "waveterm#1998 · 该报 14 · 诱饵 7 · 13 文件" },
  { id: "fe-baseline", kind: "frontend", tier: "基线", label: "前端 · 基线", sub: "加备注字段 · 跨 3 文件" },
  { id: "fe-spread", kind: "frontend", tier: "分化", label: "前端 · 分化", sub: "按分类筛选 · 合计要跟着变" },
  { id: "fe-hard", kind: "frontend", tier: "难", label: "前端 · 难", sub: "修合计不更新 · 只给症状" },
];

const cell = (task, harness) => summary.find((s) => s.task === task && s.harness === harness);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const pct = (a) => {
  if (!a) return { text: "—", n: 0, val: null };
  const v = a.mean;
  const spread = (a.max - a.min) / 2;
  const text = a.n === 1
    ? `~${(v * 100).toFixed(0)}%`
    : spread > 0.005 ? `${(v * 100).toFixed(0)}%<span class="pm">±${(spread * 100).toFixed(0)}</span>` : `${(v * 100).toFixed(0)}%`;
  return { text, n: a.n, val: v };
};
const secs = (a) => {
  if (!a) return { text: "—", val: null };
  const v = a.mean / 1000;
  const spread = (a.max - a.min) / 2000;
  return {
    text: a.n === 1 ? `~${v.toFixed(0)}s` : spread > 1 ? `${v.toFixed(0)}s<span class="pm">±${spread.toFixed(0)}</span>` : `${v.toFixed(0)}s`,
    val: v,
  };
};

// 每道题内部做归一，条形只表达「这题里谁相对高/低」，不跨题比较
function bar(val, max, tone) {
  if (val === null || val === undefined || !max) return "";
  const w = Math.max(2, Math.round((val / max) * 100));
  return `<span class="bar ${tone}" style="width:${w}%"></span>`;
}

function reviewTable(task) {
  const cells = HARNESS_ORDER.map((h) => ({ h, s: cell(task.id, h) })).filter((x) => x.s);
  if (!cells.length) return `<p class="none">这题还没有数据。</p>`;
  const maxMs = Math.max(...cells.map((c) => c.s.ms?.mean ?? 0));
  const rows = cells
    .sort((a, b) => (a.s.ms?.mean ?? 0) - (b.s.ms?.mean ?? 0))
    .map(({ h, s }) => {
      const t = secs(s.ms);
      const p = pct(s.precision);
      const r = pct(s.recall);
      const nz = pct(s.noise);
      const timedOut = s.timedOut > 0;
      return `<tr${timedOut ? ' class="dead"' : ""}>
        <td class="h">${esc(h)}</td>
        <td class="num">${s.n}</td>
        <td class="num t">${t.text}${bar(t.val, maxMs / 1000, "slow")}</td>
        <td class="num">${s.generated ? s.generated.mean.toFixed(1) : "—"}</td>
        <td class="num">${p.text}${bar(p.val, 1, "good")}</td>
        <td class="num">${r.text}${bar(r.val, 1, "good")}</td>
        <td class="num">${nz.text}</td>
        <td class="num">${(s.formatStrict * 100).toFixed(0)}%</td>
        <td class="note">${timedOut ? `<span class="flag">${s.timedOut}/${s.n} 次超时</span>` : ""}${s.retries ? `<span class="flag dim">重试 ${s.retries}</span>` : ""}${s.touched ? `<span class="flag">动了文件</span>` : ""}</td>
      </tr>`;
    })
    .join("");
  return `<div class="tscroll"><table>
    <thead><tr><th>harness</th><th>n</th><th>耗时</th><th>报</th><th>精确</th><th>召回</th><th>噪声</th><th>守约</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function feTable(task) {
  const cells = HARNESS_ORDER.map((h) => ({ h, s: cell(task.id, h) })).filter((x) => x.s);
  if (!cells.length) return `<p class="none">这题还没有数据。</p>`;
  const maxMs = Math.max(...cells.map((c) => c.s.ms?.mean ?? 0));
  const rows = cells
    .sort((a, b) => (a.s.ms?.mean ?? 0) - (b.s.ms?.mean ?? 0))
    .map(({ h, s }) => {
      const t = secs(s.ms);
      const sp = pct(s.specRate);
      const solved = s.solved;
      return `<tr${s.timedOut ? ' class="dead"' : ""}>
        <td class="h">${esc(h)}</td>
        <td class="num">${s.n}</td>
        <td class="num t">${t.text}${bar(t.val, maxMs / 1000, "slow")}</td>
        <td class="num ${solved === 1 ? "ok" : solved === 0 ? "bad" : ""}">${(solved * 100).toFixed(0)}%</td>
        <td class="num">${sp.text}${bar(sp.val, 1, "good")}</td>
        <td class="num ${s.regressed > 0 ? "bad" : ""}">${(s.regressed * 100).toFixed(0)}%</td>
        <td class="num">${s.filesChanged ? s.filesChanged.mean.toFixed(0) : "—"}</td>
        <td class="num">${s.falseClaimRate === null ? "—" : `${(s.falseClaimRate * 100).toFixed(0)}%`}</td>
        <td class="note">${s.timedOut ? `<span class="flag">${s.timedOut}/${s.n} 次超时</span>` : ""}${s.retries ? `<span class="flag dim">重试 ${s.retries}</span>` : ""}</td>
      </tr>`;
    })
    .join("");
  return `<div class="tscroll"><table>
    <thead><tr><th>harness</th><th>n</th><th>耗时</th><th>完成</th><th>验收</th><th>回归</th><th>改动</th><th>虚报</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

const singles = summary.filter((s) => s.n === 1).length;
const filled = summary.length;

const sections = TASKS.map((t) => `
  <section class="task">
    <div class="task-head">
      <div>
        <span class="tier tier-${t.tier === "基线" ? "b" : t.tier === "分化" ? "s" : "h"}">${t.tier}</span>
        <h2>${t.label}</h2>
      </div>
      <span class="sub">${esc(t.sub)}</span>
    </div>
    ${t.kind === "review" ? reviewTable(t) : feTable(t)}
  </section>`).join("");

console.log(`<title>harness-bench 结果</title>
<style>
  :root{--ground:#f4f6f7;--surface:#fff;--surface-2:#eef1f3;--ink:#161a1e;--ink-dim:#5b656d;
    --line:#dde2e6;--line-strong:#c3cbd1;--accent:#2f5d86;--ok:#26694a;--bad:#934035;
    --barslow:#c8a24a;--bargood:#5b93bd;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",sans-serif;}
  @media (prefers-color-scheme:dark){:root{--ground:#0d1115;--surface:#151a20;--surface-2:#1b222a;
    --ink:#e3e7eb;--ink-dim:#8f989f;--line:#242c34;--line-strong:#364049;--accent:#7fa8cd;
    --ok:#6cba8f;--bad:#d5837a;--barslow:#8a7130;--bargood:#3c6180;}}
  :root[data-theme="dark"]{--ground:#0d1115;--surface:#151a20;--surface-2:#1b222a;--ink:#e3e7eb;
    --ink-dim:#8f989f;--line:#242c34;--line-strong:#364049;--accent:#7fa8cd;--ok:#6cba8f;
    --bad:#d5837a;--barslow:#8a7130;--bargood:#3c6180;}
  :root[data-theme="light"]{--ground:#f4f6f7;--surface:#fff;--surface-2:#eef1f3;--ink:#161a1e;
    --ink-dim:#5b656d;--line:#dde2e6;--line-strong:#c3cbd1;--accent:#2f5d86;--ok:#26694a;
    --bad:#934035;--barslow:#c8a24a;--bargood:#5b93bd;}
  body{background:var(--ground);color:var(--ink);font-family:var(--sans);line-height:1.6;font-size:15px;
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:62rem;margin:0 auto;padding:3rem 1.5rem 5rem;display:flex;flex-direction:column;gap:2.5rem}
  .kicker{font-family:var(--mono);font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim)}
  h1{font-size:clamp(1.6rem,4vw,2.1rem);font-weight:640;letter-spacing:-.02em;margin:.4rem 0 .6rem;text-wrap:balance}
  .lede{color:var(--ink-dim);max-width:46rem}
  .caveat{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--barslow);
    border-radius:2px;padding:.85rem 1.05rem;font-size:.92rem}
  .caveat b{color:var(--ink)}
  .task{display:flex;flex-direction:column;gap:.7rem}
  .task-head{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap;
    border-bottom:1px solid var(--line-strong);padding-bottom:.5rem}
  .task-head>div{display:flex;align-items:baseline;gap:.6rem}
  h2{font-size:1.1rem;font-weight:620;margin:0}
  .tier{font-family:var(--mono);font-size:.62rem;letter-spacing:.09em;padding:.14rem .42rem;border-radius:2px}
  .tier-b{background:var(--surface-2);color:var(--ink-dim)}
  .tier-s{background:var(--surface-2);color:var(--accent)}
  .tier-h{background:var(--surface-2);color:var(--bad)}
  .sub{font-family:var(--mono);font-size:.74rem;color:var(--ink-dim)}
  .tscroll{overflow-x:auto;border:1px solid var(--line);border-radius:2px;background:var(--surface)}
  table{border-collapse:collapse;width:100%;font-size:.86rem;min-width:38rem}
  th,td{padding:.5rem .7rem;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
  thead th{font-family:var(--mono);font-size:.64rem;letter-spacing:.09em;text-transform:uppercase;
    color:var(--ink-dim);font-weight:500;background:var(--surface-2);white-space:nowrap}
  tbody tr:last-child td{border-bottom:none}
  td.h{font-family:var(--mono);font-weight:600;white-space:nowrap}
  td.num{font-variant-numeric:tabular-nums;white-space:nowrap;position:relative}
  td.ok{color:var(--ok);font-weight:600}
  td.bad{color:var(--bad);font-weight:600}
  tr.dead td{opacity:.62}
  .pm{color:var(--ink-dim);font-size:.85em;margin-left:.1em}
  .bar{display:block;height:2px;margin-top:.22rem;border-radius:1px;max-width:100%}
  .bar.slow{background:var(--barslow)}
  .bar.good{background:var(--bargood)}
  .flag{font-family:var(--mono);font-size:.66rem;color:var(--bad);background:var(--surface-2);
    padding:.1rem .34rem;border-radius:2px;margin-right:.3rem;white-space:nowrap}
  .flag.dim{color:var(--ink-dim)}
  .none{color:var(--ink-dim);font-size:.9rem;font-style:italic;padding:.4rem 0}
  footer{border-top:1px solid var(--line);padding-top:.9rem;font-family:var(--mono);font-size:.78rem;color:var(--ink-dim)}
</style>
<div class="wrap">
  <header>
    <div class="kicker">herdgent / bench · deepseek-v4-flash · 五个 harness</div>
    <h1>同模型下的 harness 横向对比</h1>
    <p class="lede">模型固定成 <b>deepseek-v4-flash</b>，五个 harness 干同一批活。
    每道题的 prompt、初始状态、超时与判分器完全一致；各家自己的系统提示、工具集与上下文策略保持原样 —— 那正是被测的东西。</p>
  </header>

  <div class="caveat">
    共 <b>${totalRuns}</b> 次运行，其中 <b>${droppedInfra}</b> 次因网关抖动剔除（不计入能力分）。
    <b>${singles}/${filled}</b> 个格子只有 1 次运行，标 <code>~</code>。
    实测同配置的运行间方差能到 2 倍（codex 同一道题跑出过精确 67% 与 33%）——
    <b>落在这个范围内的差距读作「分不出」，不要当排名看</b>。
  </div>

  ${sections}

  <footer>判分主指标零 LLM：评审比对文件路径 + 行号区间；前端跑隐藏测试。</footer>
</div>`);
