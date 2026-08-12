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
  check("评审步骤用的是另一家厂商", p.steps[1].profile === "review-opus", p.steps[1].profile);
  // branch 是【容器级】的，不再挂在步骤上；容器类型才是模板要声明的东西
  check("写代码的预设用 rex 模式", p.mode === "rex", String(p.mode));
  check("只读预设用 fox 模式", getPreset("fanout-review").mode === "fox", String(getPreset("fanout-review").mode));
  check(
    "并行评审是一步多 profile 而不是多步",
    getPreset("fanout-review").steps.length === 1 && Array.isArray(getPreset("fanout-review").steps[0].profile),
    `${getPreset("fanout-review").steps.length} 步`,
  );
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
  check("缺参数报得出来", missingInputs(p, { task: "x" }).includes("label"));
  check("空白串算缺", missingInputs(p, { task: "x", label: "   " }).includes("label"));
  check("齐了就没缺", missingInputs(p, { task: "x", label: "n" }).length === 0);
}

// ---- 用户覆盖 ----
{
  writeFileSync(
    join(home, "config", "presets.json"),
    JSON.stringify({
      presets: {
        "impl-and-review": { steps: [{ id: "only", profile: "impl-kimi", task: "{{task}}" }] },
        "my-own": { description: "自定义的", steps: [{ id: "a", profile: "explore-deepseek", task: "x" }] },
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

// ---- 模式 ----
{
  const { allModes, getMode, skillPathFor } = await import(`../lib/modes.mjs?t=${Date.now()}`);
  const modes = allModes();
  check("内置两种模式", Object.keys(modes).sort().join(",") === "fox,rex", Object.keys(modes).join(","));
  check("rex 是 worktree 容器", modes.rex.container === "worktree", modes.rex.container);
  check("fox 是 tab 容器", modes.fox.container === "tab", modes.fox.container);
  check("两份 playbook 都找得到",
    !!skillPathFor(modes.rex, "rex") && !!skillPathFor(modes.fox, "fox"));
  let code = null;
  try { getMode("nope"); } catch (e) { code = e.code; }
  check("未知模式报 unknown_mode", code === "unknown_mode", String(code));

  writeFileSync(join(home, "config", "modes.json"),
    JSON.stringify({ modes: { owl: { container: "tab", description: "自定义的", skill: "owl" } } }));
  const withUser = allModes();
  check("用户可新增模式", !!withUser.owl && withUser.owl.source === "user", Object.keys(withUser).join(","));
}

rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
