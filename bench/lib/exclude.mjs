// 统一的「这条记录不能算数」判定。
//
// 【两种失败必须分开】：
//   基础设施失败 —— 网关抖动等，runner 已经标了 infraFailure
//   评测配置失败 —— 我自己把参数定错了造成的假失败，比如超时给少了
//
// 后者尤其阴：数字看着就是「它做不到」，而真相是「我没给够」。
// claude 在 review-hard 上三次跑满 900 秒判 0%，放宽后 784–1277 秒全部完成 ——
// 那三个 0 是我的设置造成的，混进均值就把结论带偏了。
//
// 规则写在 exclude.json 里而不是散在各处的 if：要能一眼看全「排除了什么、为什么」。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// lib/ 的上一级就是 bench/ —— 别再拼一次 "bench"（踩过：路径拼成 bench/bench/，
// 读不到文件，而 catch 把错误吞了，于是【排除规则一条都没生效却毫无征兆】，
// 5 次配置造成的假失败照样进了统计）。
const BENCH = dirname(dirname(fileURLToPath(import.meta.url)));
const RULES_FILE = join(BENCH, "exclude.json");

let RULES = null;
async function rules() {
  if (RULES) return RULES;
  try {
    RULES = JSON.parse(await readFile(RULES_FILE, "utf8")).rules ?? [];
  } catch (e) {
    // 【不静默】。读不到规则文件意味着该排除的都会被算进统计，
    // 那比少个功能严重得多 —— 数字照样出来，只是错的。
    if (e.code === "ENOENT") {
      RULES = [];
      console.error(`[exclude] 没有 ${RULES_FILE}，本次不排除任何记录`);
    } else {
      throw new Error(`[exclude] 规则文件读不了：${RULES_FILE}\n${e.message}`);
    }
  }
  return RULES;
}

/** @returns {reason: string} | null —— 有值表示该条记录要排除 */
export async function excluded(r) {
  // 1. 基础设施失败（runner 标的）
  if (r.infraFailure) return { reason: "网关抖动" };

  // 2. 旧记录没有 infraFailure 字段时的启发式补判
  if (r.infraFailure === undefined && r.ms < 20_000) {
    const noOutput = r.parseOk === false || (!r.total_generated && !r.testPassed && !r.filesChanged);
    if (noOutput) return { reason: "网关抖动（启发式补判）" };
  }

  // 3. 评测配置造成的假失败
  for (const rule of await rules()) {
    if (rule.task && rule.task !== r.task) continue;
    if (rule.harness && rule.harness !== r.harness) continue;
    if (rule.timedOut !== undefined && !!r.timedOut !== rule.timedOut) continue;
    if (rule.msAround && Math.abs(r.ms / 1000 - rule.msAround) > 30) continue;
    return { reason: rule.reason };
  }
  return null;
}
