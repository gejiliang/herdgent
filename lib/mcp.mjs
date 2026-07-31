// 最小 MCP stdio server。零依赖手写 JSON-RPC——协议面很小，不值一个 npm 依赖
// 和随之而来的 [[build]] 步骤（见 AGENTS.md 代码约定）。
//
// 实测依据（Claude Code 2.1.220，findings 第十节）：
//   · --mcp-config 是合并语义，注入不会盖掉用户自己的 MCP server。
//   · stdio server 没有 per-request timer，墙钟默认约 28 小时。
//   · 真正的闸是 30 分钟 idle：无响应【且】无 progress 即中止。
//   · Claude Code 会发 progressToken，实测在 params._meta.progressToken。
//     → 长等待工具靠定期 progress 续命，不必设计成短超时 + 轮询。
import { createInterface } from "node:readline";

// idle 上限是 30 分钟，取 60 秒足够宽松，也不会把日志刷爆。
const PROGRESS_INTERVAL_MS = 60_000;

export function createServer({ name, version, tools, onLog }) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const log = (s) => onLog?.(s);

  const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
  const replyError = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

  // 工具的返回值统一包成 MCP 的 content 形状。对象一律 JSON 化：
  // orchestrator 侧要的是结构化数据，不是给人看的散文。
  const asContent = (value) => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return { content: [{ type: "text", text }] };
  };

  async function callTool(id, params) {
    const tool = byName.get(params?.name);
    if (!tool) return replyError(id, -32602, `unknown tool: ${params?.name}`);

    const token = params?._meta?.progressToken;
    let ticks = 0;
    // 心跳只在客户端给了 token 时才发。没有 token 就没有合法的通知目标，
    // 乱发会让严格的客户端报协议错误。
    const timer =
      token === undefined
        ? null
        : setInterval(() => {
            write({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: {
                progressToken: token,
                progress: ++ticks,
                message: `${tool.name} still running (${ticks}m)`,
              },
            });
          }, PROGRESS_INTERVAL_MS);

    try {
      const result = await tool.handler(params?.arguments ?? {});
      reply(id, asContent(result));
    } catch (e) {
      // 工具失败要让模型看得懂并能自己改正，所以把错误码和消息一起交回去，
      // 而不是丢一个裸 -32603。
      log(`tool ${tool.name} failed: ${e.code || "?"}: ${e.message}`);
      reply(id, {
        ...asContent({ error: e.code || "tool_failed", message: e.message }),
        isError: true,
      });
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  const rl = createInterface({ input: process.stdin });

  rl.on("line", async (line) => {
    if (!line.trim()) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`bad json in: ${line.slice(0, 200)}`);
      return;
    }

    const { id, method, params } = msg;
    log(`<- ${method} id=${id ?? "-"}`);

    if (method === "initialize") {
      // 回显客户端的 protocolVersion，不自己猜版本号。
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name, version },
      });
    }

    if (method === "tools/list") {
      return reply(id, {
        tools: tools.map(({ name: n, description, inputSchema }) => ({
          name: n,
          description,
          inputSchema,
        })),
      });
    }

    if (method === "tools/call") return callTool(id, params);

    // 通知没有 id，不能回复——回了就是协议错误。
    if (id === undefined || id === null) return;

    replyError(id, -32601, `method not found: ${method}`);
  });

  // stdin 关闭意味着 harness 会话结束了，这个进程该走了。
  rl.on("close", () => process.exit(0));

  log(`server ${name}@${version} started pid=${process.pid} tools=${tools.length}`);
}
