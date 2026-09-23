#!/usr/bin/env node
// session-start 的 profile 选择验收。不起会话、不碰 herdr，所以进 npm test。
//
// 守的不变量：独立会话也走 profile（「用什么跑」的唯一真源），
// 配置缺失/损坏回内置默认，配置里写了未知 profile 名在【起会话之前】就报错，
// 绝不静默退回裸 claude。
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// 两道隔离，都是结构性的：
//   · HERDGENT_HOME 指到临时目录——否则用户真实的 ~/.herdgent/config/profiles.json
//     会漏进测试，「未知 profile」可能恰好被用户配置定义了。
//   · HERDR_SOCKET_PATH 指到【不存在的路径】——万一哪天改动让这条测试路径碰到
//     herdr，它必须连不上真 server，而不是在 GG 的工作区里建 workspace。
//     空字符串不行：falsy 会让 herdr CLI 回落到默认 session，这个坑翻过车。
const home = mkdtempSync(join(tmpdir(), "hg-session-start-"));
process.env.HERDGENT_HOME = home;
process.env.HERDR_SOCKET_PATH = join(home, "no-such-dir", "herdr.sock");

const { sessionStartProfile, applyProfile, getProfile, DEFAULT_SESSION_START_PROFILE } = await import(
  `../lib/profiles.mjs?t=${Date.now()}`
);

// ---- 默认值本身要成立 ----
{
  check("默认不是 fallback 专用的 impl-glm", DEFAULT_SESSION_START_PROFILE !== "impl-glm", DEFAULT_SESSION_START_PROFILE);
  const spec = applyProfile({ profile: DEFAULT_SESSION_START_PROFILE });
  const p = getProfile(DEFAULT_SESSION_START_PROFILE);
  check(
    "默认 profile 能完整展开（harness/yolo/effort/prompt）",
    spec.harness === p.harness && spec.yolo === true && !!spec.effort && !!spec.prompt,
    `${spec.harness} yolo=${spec.yolo} effort=${spec.effort}`,
  );
}

// ---- 情况 1：配置文件不存在 → 默认 ----
{
  check("配置目录不存在 → 默认", sessionStartProfile(join(home, "no-such-dir")) === DEFAULT_SESSION_START_PROFILE);
  const dir = mkdtempSync(join(tmpdir(), "hg-sscfg-"));
  check("config.json 不存在 → 默认", sessionStartProfile(dir) === DEFAULT_SESSION_START_PROFILE);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ max_workers: 6 }));
  check("config.json 没写这个键 → 默认", sessionStartProfile(dir) === DEFAULT_SESSION_START_PROFILE);
  rmSync(dir, { recursive: true, force: true });
}

// ---- 情况 2：配置合法 → 用配置里写的 ----
{
  const dir = mkdtempSync(join(tmpdir(), "hg-sscfg-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ session_start_profile: "impl-kimi" }));
  check("合法配置 → 配置里的 profile", sessionStartProfile(dir) === "impl-kimi");
  rmSync(dir, { recursive: true, force: true });
}

// ---- 情况 3：坏 JSON → 不抛异常，回默认 ----
{
  const dir = mkdtempSync(join(tmpdir(), "hg-sscfg-"));
  writeFileSync(join(dir, "config.json"), "{not json");
  let threw = false;
  let name = null;
  try {
    name = sessionStartProfile(dir);
  } catch {
    threw = true;
  }
  check("坏 JSON 不抛异常", !threw);
  check("坏 JSON → 默认", name === DEFAULT_SESSION_START_PROFILE, String(name));
  rmSync(dir, { recursive: true, force: true });
}

// ---- 情况 3b：JSON 合法但字段类型不对 → 不抛异常，回默认 ----
{
  const dir = mkdtempSync(join(tmpdir(), "hg-sscfg-"));
  for (const bad of [123, ["impl-kimi"], null, { name: "impl-kimi" }, true]) {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ session_start_profile: bad }));
    let threw = false;
    let name = null;
    try {
      name = sessionStartProfile(dir);
    } catch {
      threw = true;
    }
    check(`类型不对（${JSON.stringify(bad)}）不抛异常、回默认`, !threw && name === DEFAULT_SESSION_START_PROFILE, String(name));
  }
  // 空白字符串也不是有效 profile 名
  writeFileSync(join(dir, "config.json"), JSON.stringify({ session_start_profile: "   " }));
  check("空白字符串 → 默认", sessionStartProfile(dir) === DEFAULT_SESSION_START_PROFILE);
  rmSync(dir, { recursive: true, force: true });
}

// ---- 五个字段真的到位：applyProfile(sessionStartProfile(dir)) 的返回值 ----
// 不起会话——断言返回 spec 里 harness / model / yolo / effort / prompt 都在
// 且等于该 profile 的定义值。bin/session-start.mjs 把这五个字段透传给
// startManagedSession，spec 对就说明会传下去。
{
  const dir = mkdtempSync(join(tmpdir(), "hg-sscfg-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ session_start_profile: "impl-kimi" }));
  const spec = applyProfile({ profile: sessionStartProfile(dir) });
  const p = getProfile("impl-kimi");
  for (const key of ["harness", "model", "yolo", "effort", "prompt"]) {
    const expected = p[key] ?? (key === "yolo" ? false : null);
    check(
      `透传字段 ${key} 等于 profile 定义值`,
      spec[key] !== undefined && spec[key] === expected,
      `${JSON.stringify(spec[key])?.slice(0, 40)} vs ${JSON.stringify(expected)?.slice(0, 40)}`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
}

// ---- 情况 4：配置里写了不存在的 profile 名 → 起会话之前就报错 ----
{
  const dir = mkdtempSync(join(tmpdir(), "hg-sscfg-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ session_start_profile: "no-such-profile" }));
  const name = sessionStartProfile(dir);
  check("选择函数不校验、原样返回", name === "no-such-profile", name);
  let code = null;
  try {
    applyProfile({ profile: name });
  } catch (e) {
    code = e.code;
  }
  check("未知 profile 在 applyProfile 就炸", code === "unknown_profile", String(code));

  // 顺序保证：bin/session-start.mjs 里 applyProfile 必须先于 startManagedSession 调用，
  // 否则「起会话之前报错」就是空话。静态核对调用点的先后（不起会话，不能真跑）。
  const src = readFileSync(new URL("../bin/session-start.mjs", import.meta.url), "utf8");
  const iApply = src.indexOf("applyProfile({");
  const iStart = src.indexOf("startManagedSession({");
  check(
    "applyProfile 先于 startManagedSession",
    iApply !== -1 && iStart !== -1 && iApply < iStart,
    `apply@${iApply} start@${iStart}`,
  );
  rmSync(dir, { recursive: true, force: true });
}

// ---- 五个字段【真的传下去了】----
//
// 评审抓到的盲区：只断言 applyProfile 返回的 spec 正确，等于没测透传——
// 以后有人删掉 `model: spec.model` 或写错映射，上面那些用例照样全绿。
// 真观察 startManagedSession 的入参要么起真会话（不行），要么加一层间接（不值得
// 为一个二十行的脚本这么干），所以退而求其次：静态核对调用点里五个字段都在，
// 且每个都取自 spec。这精确对应「以后有人删掉一行」这个风险。
{
  const src = readFileSync(new URL("../bin/session-start.mjs", import.meta.url), "utf8");
  const call = src.slice(src.indexOf("startManagedSession({"));
  const body = call.slice(0, call.indexOf("});") + 3);

  for (const [field, expr] of [
    ["harness", "spec.harness"],
    ["model", "spec.model"],
    ["effort", "spec.effort"],
    ["yolo", "spec.yolo"],
    ["readOnly", "spec.read_only"], // 唯一一处改名
    ["prompt", "spec.prompt"],
  ]) {
    const ok = new RegExp(`${field}:\\s*${expr.replace(".", "\\.")}`).test(body);
    check(`startManagedSession 收到 ${field}`, ok, ok ? "" : `期望 ${field}: ${expr}`);
  }
}

rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
