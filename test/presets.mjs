#!/usr/bin/env node
// 预设的数据层验收：加载、合并、模板渲染、必填检查。
// 不碰 herdr，不起会话，所以进 npm test。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const home = mkdtempSync(join(tmpdir(), "hg-presets-"));
mkdirSync(join(home, "config"), { recursive: true });
process.env.HERDGENT_HOME = home;

const { allPresets, getPreset, render, missingInputs } = await import(
  `../lib/presets.mjs?t=${Date.now()}`
);

// ---- 内置 ----
{
  const names = Object.keys(allPresets());
  check("内置预设可列出", names.includes("impl-and-review") && names.includes("fanout-review"), names.join(","));
  const p = getPreset("impl-and-review");
  check("预设声明了 inputs", Object.keys(p.inputs).length > 0, Object.keys(p.inputs).join(","));
  check("评审步骤用的是另一家厂商", p.steps[1].profile === "review-gemini", p.steps[1].profile);
  check("实现步骤要 branch", !!p.steps[0].branch, String(p.steps[0].branch));
  check("评审步骤挂上游 diff", p.steps[1].attach === "diff_of:impl", p.steps[1].attach);
}

// ---- 模板渲染 ----
{
  check("变量被替换", render("做 {{task}} 到 {{branch}}", { task: "X", branch: "b1" }) === "做 X 到 b1");
  // 缺变量原样留着：静默变空会让任务描述看起来完整但实际缺内容
  check("缺失变量原样保留", render("需要 {{nope}}", {}) === "需要 {{nope}}", render("需要 {{nope}}", {}));
  check("非字符串输入不炸", render(undefined, {}) === "");
}

// ---- 必填检查 ----
{
  const p = getPreset("impl-and-review");
  check("缺参数报得出来", missingInputs(p, { task: "x" }).includes("branch"));
  check("空白串算缺", missingInputs(p, { task: "x", branch: "   " }).includes("branch"));
  check("齐了就没缺", missingInputs(p, { task: "x", branch: "b" }).length === 0);
}

// ---- 用户覆盖 ----
{
  writeFileSync(
    join(home, "config", "presets.json"),
    JSON.stringify({
      presets: {
        "impl-and-review": { steps: [{ id: "only", profile: "codex-impl", task: "{{task}}" }] },
        "my-own": { description: "自定义的", steps: [{ id: "a", profile: "explore-fast", task: "x" }] },
      },
    }),
  );
  const merged = allPresets();
  check("用户新增的预设出现", !!merged["my-own"], Object.keys(merged).join(","));
  check("同名覆盖内置", merged["impl-and-review"].steps.length === 1, `${merged["impl-and-review"].steps.length} 步`);
  check("覆盖被标记出来", merged["impl-and-review"].source === "user-override", merged["impl-and-review"].source);
  check("未被覆盖的仍是 builtin", merged["fanout-review"].source === "builtin");
}

// ---- 坏预设 ----
{
  let code = null;
  try {
    getPreset("no-such-preset");
  } catch (e) {
    code = e.code;
  }
  check("未知预设报 unknown_preset", code === "unknown_preset", String(code));
}

rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
