#!/usr/bin/env node
// 重试判据自测。
//
// 判据错了有两个方向的代价，都很贵：
//   放太宽 —— 真实的能力失败被当成网络问题反复重跑，烧钱且拿不到真实分数
//   放太严 —— 一次网络抖动被记成「这家能力差」，而它上一次同题是正常的
// 所以两边都要测。

import { looksLikeInfraFailure } from "./runner.mjs";

let fail = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fail++;
};

console.log("该重试的：网关/网络层错误且什么都没产出");
check("证书验证失败（opencode 实测）", looksLikeInfraFailure(
  { stderr: "\nError: unknown certificate verification error\n" }, ""));
check("连接被重置", looksLikeInfraFailure({ stderr: "read ECONNRESET" }, ""));
check("DNS 解析不了", looksLikeInfraFailure({ stderr: "getaddrinfo ENOTFOUND newapi.example.com" }, ""));
check("被限流", looksLikeInfraFailure({ stderr: "429 Too Many Requests" }, ""));
check("网关 502", looksLikeInfraFailure({ stderr: "502 Bad Gateway" }, ""));
check("空 text（只有空白）也算没产出", looksLikeInfraFailure(
  { stderr: "socket hang up" }, "   \n  "));

console.log("\n不该重试的：产出了内容，或根本不是网络问题");
check("有输出就不算网络失败——哪怕 stderr 里有噪声", !looksLikeInfraFailure(
  { stderr: "warning: ECONNRESET on a background probe" },
  '[{"path":"a.go","from_line":1,"to_line":2,"note":"x"}]'));
check("模型说不出话，但不是网络问题", !looksLikeInfraFailure(
  { stderr: "model refused to answer" }, ""));
check("stderr 干净且无输出（真空跑，是能力问题）", !looksLikeInfraFailure({ stderr: "" }, ""));
check("超时不算网络失败（超时另有 timedOut 标记）", !looksLikeInfraFailure(
  { stderr: "Terminated by signal" }, ""));
check("stderr 缺失时不炸", !looksLikeInfraFailure({}, ""));

console.log(fail === 0 ? "\n重试判据自测全过。" : `\n${fail} 项未通过。`);
process.exit(fail ? 1 : 0);
