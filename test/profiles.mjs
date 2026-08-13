#!/usr/bin/env node
// profile 的数据层验收。不碰 herdr，不起会话，所以进 npm test。
//
// 这里守两条【产品级】不变量：
//   1. profile 是「用什么跑」的唯一真源。能被按次覆盖的话，分工就管不住——
//      编排者可以绕过人定的分工自己挑模型，而谁干活、谁评审、烧谁的额度
//      恰恰是人要掌握的那一层。
//   2. 主力与 fallback 的分工必须在 profile 数据里标出来，且只标一个 fallback。
//      派谁不派谁是 skill 的事，但「哪个是备胎」不能靠编排者猜。
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

// ---- 命名：角色在前 ----
{
  const names = Object.keys(allProfiles());
  check(
    "profile 名都是 <角色>-<模型>",
    names.every((n) => /^(impl|review|explore)-/.test(n)),
    names.join(","),
  );
}

// ---- 配额分池 ----
{
  const p = allProfiles();
  const impls = Object.entries(p).filter(([n]) => n.startsWith("impl-"));
  const reviews = Object.entries(p).filter(([n]) => n.startsWith("review-"));

  check("三个实现档位都在", impls.length === 3, impls.map(([n]) => n).join(","));

  // 硬约束 1：Claude 模型做 agent 只能走原生通道。网关代理的 Claude 只适合
  // 简单调用，拿来跑 agent 不行。所以【经 pi 的 profile 里不能出现 claude 模型】。
  const viaPi = Object.entries(p).filter(([, x]) => x.harness === "pi");
  check(
    "没有经网关跑的 Claude 模型",
    viaPi.every(([, x]) => !/claude/i.test(x.model ?? "")),
    viaPi.map(([n, x]) => `${n}:${x.model}`).join(" "),
  );
  check("Sonnet 5 走原生 claude", p["impl-sonnet"].harness === "claude", `${p["impl-sonnet"].harness} ${p["impl-sonnet"].model}`);
  check("Opus 5 走原生 claude", p["review-opus"].harness === "claude", p["review-opus"].harness);

  // 硬约束 2：主力与 fallback 的分工必须写在 description 里。
  // 「什么时候派」是调度语义，活在 skill 里，引擎不认识 fallback 这个概念——
  // 所以这里只能验「标没标」，验不了「派没派对」。
  // 【2026-08-12 起主力是 impl-kimi + impl-sonnet】，fallback 是 impl-glm。
  // 原来那条「实现主力不许烧 Claude 订阅」随之作废：GPT 下线后没有第二个够格的
  // 非 Claude 主力，GG 决定把 Sonnet 提上来。

  // 跨厂商评审是 rex 的硬规则，前提是【每个实现者都能找到一个别家的评审】。
  // 厂商不能从模型名或 harness 推——review-kimi 与 review-deepseek 都走 pi 却是两家，
  // sonnet 与 opus 名字不同却同属 Anthropic——所以 profile 显式标 vendor。
  // GPT 下线那次差点把评审侧砍到只剩 Claude 一家，这条守住那个下限。
  check("每个 profile 都标了厂商", Object.values(p).every((x) => !!x.vendor), Object.entries(p).filter(([, x]) => !x.vendor).map(([n]) => n).join(",") || "全标了");
  check(
    "每个实现者都有别家厂商的评审可配",
    impls.every(([, i]) => reviews.some(([, r]) => r.vendor !== i.vendor)),
    `impl ${impls.map(([, x]) => x.vendor).join(",")} / review ${reviews.map(([, x]) => x.vendor).join(",")}`,
  );
  // 恰好一个 fallback：零个的话「都不可用时派谁」没有答案，两个的话编排者得自己
  // 排优先级——而排优先级正是这里要替他定死的事。
  const fallbacks = impls.filter(([, x]) => /FALLBACK/i.test(x.description ?? ""));
  check("实现档里恰好一个标着 fallback", fallbacks.length === 1, fallbacks.map(([n]) => n).join(",") || "一个都没标");
  check("fallback 是 impl-glm", fallbacks[0]?.[0] === "impl-glm", String(fallbacks[0]?.[0]));

  // 评审必须是只读的，否则「评审」会去改代码——踩过。
  check("所有 review-* 都是只读", reviews.every(([, x]) => x.read_only === true), `${reviews.length} 个`);
  check("所有 review-* 都不 yolo", reviews.every(([, x]) => !x.yolo), `${reviews.length} 个`);
  check("所有 impl-* 都要分支", impls.every(([, x]) => x.wants_branch === true), `${impls.length} 个`);

  // 经 pi 的模型必须带 provider 前缀：不带的话 pi 会模糊匹配到别家，
  // 报 "No API key found" 而任务静默不执行。
  const piModels = Object.values(p).filter((x) => x.harness === "pi" && x.model).map((x) => x.model);
  check("pi 的模型都带 provider 前缀", piModels.every((m) => m.includes("/")), piModels.join(", "));
}

// ---- 思考等级 ----
{
  const p = allProfiles();
  const heavy = Object.entries(p).filter(([n]) => /^(impl|review)-/.test(n));
  check("实现与评审的思考等级全拉满", heavy.every(([, x]) => x.effort === "max"), heavy.map(([n, x]) => `${n}:${x.effort}`).join(" "));
  // explore 的定位是快 + 便宜。拉满就既不快也不便宜，那就该直接派评审档的模型。
  check("explore 不拉思考等级", !p["explore-deepseek"].effort, String(p["explore-deepseek"].effort));
}

// ---- profile 是唯一真源：这些维度覆盖不了 ----
{
  const spec = applyProfile({
    profile: "review-kimi",
    title: "x",
    task: "y",
    harness: "claude",
    model: "gpt-5.6-sol",
    effort: "low",
    yolo: true,
    read_only: false,
  });
  const p = getProfile("review-kimi");
  check("harness 盖不过", spec.harness === p.harness, `${spec.harness} vs ${p.harness}`);
  check("model 盖不过", spec.model === p.model, `${spec.model} vs ${p.model}`);
  check("effort 盖不过", spec.effort === "max", String(spec.effort));
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
        "review-kimi": { model: "quota-proxy/ark-kimi-k3" },
        "review-minimax": { harness: "pi", model: "quota-proxy/ark-minimax-m3", read_only: true, effort: "max" },
      },
    }),
  );
  const { allProfiles: reload, applyProfile: apply2 } = await import(
    `../lib/profiles.mjs?t=${Date.now()}-2`
  );
  const p = reload();
  check("用户可新增 profile", !!p["review-minimax"], Object.keys(p).join(","));
  check("新增的标 user", p["review-minimax"].source === "user", p["review-minimax"].source);
  check("同名部分覆盖内置", p["review-kimi"].model === "quota-proxy/ark-kimi-k3", p["review-kimi"].model);
  check("覆盖被标记", p["review-kimi"].source === "user-override", p["review-kimi"].source);
  // 只写了 model 的话，内置的 prompt / read_only 要留着——否则「只覆盖模型」
  // 会悄悄把只读评审变成可写的。
  check("未覆盖的字段保留内置值", p["review-kimi"].read_only === true, String(p["review-kimi"].read_only));
  check("覆盖后仍是唯一真源", apply2({ profile: "review-kimi", model: "x" }).model === "quota-proxy/ark-kimi-k3");
}

rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
