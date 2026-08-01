#!/usr/bin/env node
// profile 的数据层验收。不碰 herdr，不起会话，所以进 npm test。
//
// 这里守的是一条【产品级】不变量：profile 是「用什么跑」的唯一真源。
// 能被按次覆盖的话，分工就管不住——编排者可以绕过人定的分工自己挑模型，
// 而谁干活、谁评审、烧谁的额度恰恰是人要掌握的那一层。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const home = mkdtempSync(join(tmpdir(), "hg-profiles-"));
mkdirSync(join(home, "config"), { recursive: true });
process.env.HERDGENT_HOME = home;

const { allProfiles, getProfile, applyProfile } = await import(`../lib/profiles.mjs?t=${Date.now()}`);

// ---- 三条通道的分工 ----
{
  const p = allProfiles();
  check("两个实现主力在", !!p["codex-impl"] && !!p["kimi-impl"], Object.keys(p).join(","));
  check("GPT 走原生 codex", p["codex-impl"].harness === "codex", p["codex-impl"].harness);
  check("Claude 走原生 claude", p["claude-impl"].harness === "claude", p["claude-impl"].harness);
  check("review-gpt 也走原生 codex", p["review-gpt"].harness === "codex", p["review-gpt"].harness);
  check("review-claude 也走原生 claude", p["review-claude"].harness === "claude", p["review-claude"].harness);

  // pi 只承载其余厂商——出现 gpt/claude 系就是分工漏了。
  const piModels = Object.values(p)
    .filter((x) => x.harness === "pi" && x.model)
    .map((x) => x.model);
  check(
    "pi 不承载 GPT / Claude",
    !piModels.some((m) => /gpt|claude/i.test(m)),
    piModels.join(", "),
  );
  check("pi 的模型都带 provider 前缀", piModels.every((m) => m.includes("/")), piModels.join(", "));

  // 评审必须是只读的，否则「评审」会去改代码——踩过。
  const reviewers = Object.entries(p).filter(([n]) => n.startsWith("review-"));
  check("所有 review-* 都是只读", reviewers.every(([, x]) => x.read_only === true), `${reviewers.length} 个`);
  check("所有 review-* 都不 yolo", reviewers.every(([, x]) => !x.yolo), `${reviewers.length} 个`);
}

// ---- profile 是唯一真源：这四个维度覆盖不了 ----
{
  const spec = applyProfile({
    profile: "review-gemini",
    title: "x",
    task: "y",
    harness: "claude",
    model: "quota-proxy/gpt-5.6-sol",
    yolo: true,
    read_only: false,
  });
  const p = getProfile("review-gemini");
  check("harness 盖不过", spec.harness === p.harness, `${spec.harness} vs ${p.harness}`);
  check("model 盖不过", spec.model === p.model, `${spec.model} vs ${p.model}`);
  check("yolo 盖不过", spec.yolo === false, String(spec.yolo));
  check("read_only 盖不过", spec.read_only === true, String(spec.read_only));
  check("prompt 来自 profile", spec.prompt === p.prompt, spec.prompt?.slice(0, 20));
  // 这些不是「用什么跑」，仍然是调用方的事。
  check("title / task 仍来自调用方", spec.title === "x" && spec.task === "y", `${spec.title}/${spec.task}`);
}

// ---- 不给 profile 就派不了活 ----
{
  let code = null;
  try {
    applyProfile({ title: "x", task: "y" });
  } catch (e) {
    code = e.code;
  }
  check("没有 profile 报 unknown_profile", code === "unknown_profile", String(code));

  let code2 = null;
  try {
    getProfile("no-such-profile");
  } catch (e) {
    code2 = e.code;
  }
  check("未知 profile 报 unknown_profile", code2 === "unknown_profile", String(code2));
}

// ---- 用户覆盖 ----
{
  writeFileSync(
    join(home, "config", "profiles.json"),
    JSON.stringify({
      profiles: {
        "review-gemini": { model: "quota-proxy/gemini-3.5-flash-low" },
        "my-reviewer": { harness: "pi", model: "quota-proxy/bailian-glm-5.2", read_only: true },
      },
    }),
  );
  const { allProfiles: reload, applyProfile: apply2 } = await import(
    `../lib/profiles.mjs?t=${Date.now()}-2`
  );
  const p = reload();
  check("用户可新增 profile", !!p["my-reviewer"], Object.keys(p).join(","));
  check("新增的标 user", p["my-reviewer"].source === "user", p["my-reviewer"].source);
  check("同名部分覆盖内置", p["review-gemini"].model === "quota-proxy/gemini-3.5-flash-low", p["review-gemini"].model);
  check("覆盖被标记", p["review-gemini"].source === "user-override", p["review-gemini"].source);
  // 只写了 model 的话，内置的 prompt / read_only 要留着——否则「只覆盖模型」
  // 会悄悄把只读评审变成可写的。
  check("未覆盖的字段保留内置值", p["review-gemini"].read_only === true, String(p["review-gemini"].read_only));
  check("覆盖后仍是唯一真源", apply2({ profile: "review-gemini", model: "x" }).model === "quota-proxy/gemini-3.5-flash-low");
}

rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
