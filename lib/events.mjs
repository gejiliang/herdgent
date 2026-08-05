// herdr 事件订阅。lib/herdr.mjs 主要走 CLI 一问一答；这里走裸 socket 收长连接推送，
// 也承载少数 CLI 没有暴露完整 JSON 结果的一次性读取。
//
// 实测的协议形状（herdr 0.7.5）：
//   请求  {"id":"s","method":"events.subscribe","params":{"subscriptions":[{...}]}}
//   应答  {"id":"s","result":{"type":"subscription_started"}}
//   推送  {"event":"pane.agent_status_changed",
//          "data":{"agent":"claude","agent_status":"working","pane_id":"w1:p1","workspace_id":"w1"}}
//
// 两条实测约束，决定了这个模块的形状：
//   1. 【只有】pane.agent_status_changed 必填 pane_id，订阅不了"所有 pane"。
//      pane.agent_detected / pane.exited / workspace.* 都不需要。
//   2. 订阅时 pane 必须存在，数组里有一个不存在的 pane 就整个请求被拒（pane_not_found）。
//      → 所以【一个 pane 一条连接】。合订会让一个 worker 的死亡牵连所有其他 worker 的等待。
//
// 推送里【没有 state_change_seq】。不需要它：推送本身就是变化通知。
// 真正的竞态是「订阅建立完成前状态已经变了」，由调用方在 onReady 里补查一次当前状态解决。
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// 编排者【不一定】跑在 herdr 里：CLI 直连一个 agent、只要结果不看过程，是正常用法。
// 那种会话没有 HERDR_SOCKET_PATH，但只要 herdr server 在跑，worker 照样起得来、看得见。
// 所以没有环境变量时退回 default session 的默认 socket，而不是直接判死。
function socketPath() {
  const p = process.env.HERDR_SOCKET_PATH;
  if (p) return p;
  const fallback = join(homedir(), ".config/herdr/herdr.sock");
  if (existsSync(fallback)) return fallback;
  throw Object.assign(
    new Error(
      "cannot find a herdr socket: HERDR_SOCKET_PATH is unset and the default session socket " +
        `(${fallback}) does not exist — is herdr running?`,
    ),
    { code: "no_socket" },
  );
}

// 一次性 socket 请求。事件订阅是长连接，这里则在拿到对应应答后立即断开。
// socket 是本机 IPC，超时说明这条辅助路径不可用；调用方可以选择降级到 CLI。
const SOCKET_REQUEST_TIMEOUT_MS = 5000;

function requestOnce(method, params) {
  return new Promise((resolve, reject) => {
    let sock;
    try {
      sock = connect(socketPath());
    } catch (e) {
      reject(e);
      return;
    }

    let buf = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        // 已经断了
      }
      fn(value);
    };
    const fail = (code, message) => finish(reject, Object.assign(new Error(message), { code }));

    sock.setTimeout(SOCKET_REQUEST_TIMEOUT_MS, () => {
      fail("socket_timeout", `herdr socket request timed out after ${SOCKET_REQUEST_TIMEOUT_MS}ms`);
    });

    sock.on("connect", () => {
      try {
        sock.write(JSON.stringify({ id: "read", method, params }) + "\n");
      } catch (e) {
        fail("socket_error", `herdr socket write: ${e.message}`);
      }
    });

    sock.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          fail("bad_output", `herdr sent non-JSON response: ${line.slice(0, 200)}`);
          return;
        }
        if (!msg || typeof msg !== "object") {
          fail("bad_output", "herdr socket response is not an object");
          return;
        }
        if (msg.id !== "read") continue;
        if (msg.error) {
          fail(msg.error.code || "request_failed", `${msg.error.code}: ${msg.error.message}`);
          return;
        }
        if (!("result" in msg)) {
          fail("bad_output", "herdr socket response has neither result nor error");
          return;
        }
        finish(resolve, msg.result);
        return;
      }
    });

    sock.on("error", (e) => fail("socket_error", `herdr socket: ${e.message}`));
    sock.on("close", () => {
      if (!settled) fail("socket_closed", "herdr socket closed before responding");
    });
  });
}

// `herdr agent read` 的 CLI 只吐终端文本，丢掉 JSON 里的 `truncated`。
// socket API 则返回完整 PaneReadResult；调用方需自行决定 socket 不可用时如何降级。
export function readAgentScreen(target, { source = "visible", lines = null } = {}) {
  const params = { target, source, format: "text", strip_ansi: true };
  if (lines != null) params.lines = lines;
  return requestOnce("agent.read", params);
}

// 订阅一组事件。返回 { close() }。
// handlers: { onReady(), onEvent(name, data), onError(err), onClose() }
// onError 之后不保证还有 onClose，调用方两个都要能收。
export function watchEvents(subscriptions, handlers = {}) {
  const sock = connect(socketPath());
  let buf = "";
  let acked = false;
  let closed = false;

  const fail = (code, message) => {
    if (closed) return;
    closed = true;
    try {
      sock.destroy();
    } catch {
      // 已经断了
    }
    handlers.onError?.(Object.assign(new Error(message), { code }));
  };

  sock.on("connect", () => {
    sock.write(
      JSON.stringify({ id: "sub", method: "events.subscribe", params: { subscriptions } }) + "\n",
    );
  });

  sock.on("data", (chunk) => {
    buf += chunk;
    let i;
    // 逐行切；一次 data 可能带半行，也可能带好几行。
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // 协议变了才会走到这里。不静默：调用方需要知道自己在盲飞。
        fail("bad_output", `herdr sent non-JSON on event stream: ${line.slice(0, 200)}`);
        return;
      }

      if (!acked) {
        acked = true;
        if (msg.error) {
          fail(msg.error.code || "subscribe_failed", `${msg.error.code}: ${msg.error.message}`);
          return;
        }
        handlers.onReady?.(msg.result);
        continue;
      }

      if (msg.event) handlers.onEvent?.(msg.event, msg.data || {});
    }
  });

  sock.on("error", (e) => fail("socket_error", `event socket: ${e.message}`));

  sock.on("close", () => {
    if (closed) return;
    closed = true;
    handlers.onClose?.();
  });

  return {
    close() {
      if (closed) return;
      closed = true;
      try {
        sock.destroy();
      } catch {
        // 已经断了
      }
    },
  };
}

// 单个 pane 的 agent 状态流。一个 pane 一条连接——见文件头第 2 条约束。
export function watchPaneStatus(paneId, handlers = {}) {
  return watchEvents([{ type: "pane.agent_status_changed", pane_id: paneId }], {
    ...handlers,
    onEvent: (name, data) => {
      if (name === "pane.agent_status_changed") handlers.onStatus?.(data.agent_status, data);
    },
  });
}

// pane 退出流。不需要 pane_id，所以【一条连接覆盖全部】——
// worker 的 pane 被关掉时，watchPaneStatus 那条连接可能只是静默断开，
// 分不清「herdr 挂了」还是「这个 pane 没了」。这条流给出确切答案。
export function watchExits(handlers = {}) {
  return watchEvents([{ type: "pane.exited" }], {
    ...handlers,
    onEvent: (name, data) => {
      if (name === "pane.exited") handlers.onExit?.(data.pane_id, data);
    },
  });
}
