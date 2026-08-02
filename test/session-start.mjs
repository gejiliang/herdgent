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
  check("默认不是 fallback 专用的 impl-sonnet", DEFAULT_SESSION_START_PROFILE !== "impl-sonnet", DEFAULT_SESSION_START_PROFILE);
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

rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
