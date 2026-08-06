// 终态和 transcript 落盘之间会有极短窗口。四次、每次相隔 250ms，最多多等 750ms：
// 足够跨过文件回填的尾巴，又不会把真正没有产出的步骤长时间伪装成可继续。
export const PLAN_OUTPUT_READ_ATTEMPTS = 4;
export const PLAN_OUTPUT_RETRY_DELAY_MS = 250;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isReadableOutput(output) {
  return output?.assistant_turns > 0 && !!String(output.text ?? "").trim();
}

export async function readPlanOutputWithRetry(read) {
  let lastOutput = null;
  let lastError = null;

  for (let attempt = 1; attempt <= PLAN_OUTPUT_READ_ATTEMPTS; attempt += 1) {
    try {
      const output = await read();
      if (isReadableOutput(output)) return { ready: true, output, error: null, attempts: attempt };
      lastOutput = output;
      lastError = null;
    } catch (error) {
      lastOutput = null;
      lastError = error;
    }

    if (attempt < PLAN_OUTPUT_READ_ATTEMPTS) await wait(PLAN_OUTPUT_RETRY_DELAY_MS);
  }

  return { ready: false, output: lastOutput, error: lastError, attempts: PLAN_OUTPUT_READ_ATTEMPTS };
}
