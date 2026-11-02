/** HTTP（Streamable HTTP）传输：用于部署到服务器，作为 claude.ai 自定义连接器。 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { NeteaseClient } from "./client.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./tools.js";

const log = (...args: unknown[]) => console.error(`[${SERVER_NAME}]`, ...args);

function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new Error("请求体过大");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

export function startHttp(client: NeteaseClient, opts: { port: number; host: string; token: string }) {
  const { token } = opts;

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true, name: SERVER_NAME, version: SERVER_VERSION });

    // 两种鉴权方式任选其一：
    //   1. 把令牌放在路径里：/mcp/<token>   （claude.ai 自定义连接器只能填 URL，用这种）
    //   2. 请求头 Authorization: Bearer <token>，路径为 /mcp
    let authorized = false;
    if (url.pathname.startsWith("/mcp/")) {
      authorized = tokensEqual(decodeURIComponent(url.pathname.slice(5)), token);
    } else if (url.pathname === "/mcp") {
      const auth = req.headers.authorization ?? "";
      authorized = auth.startsWith("Bearer ") && tokensEqual(auth.slice(7).trim(), token);
    } else {
      return sendJson(res, 404, { error: "not found" });
    }
    if (!authorized) return sendJson(res, 401, { error: "unauthorized" });

    if (req.method !== "POST") {
      // 无状态模式下不支持 GET (SSE) / DELETE
      return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    }

    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: `Parse error: ${(err as Error).message}` }, id: null });
    }

    // 无状态：每个请求新建一个 MCP server + transport，共享同一个网易云客户端（同一份登录状态）
    // 远程模式默认不提供本机播放控制（否则控制的是服务器而不是用户的电脑）；在自己电脑上跑 HTTP 模式时可设 NETEASE_LOCAL_CONTROL=1 开启
    const server = createServer(client, { localControl: process.env.NETEASE_LOCAL_CONTROL === "1" });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log("处理请求出错：", err);
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });

  httpServer.listen(opts.port, opts.host, () => {
    log(`HTTP 模式已启动 v${SERVER_VERSION}：http://${opts.host}:${opts.port}`);
    log(`  连接器 URL：  http(s)://<你的域名>/mcp/${token}`);
    log(`  或使用请求头：Authorization: Bearer <token>，URL 为 /mcp`);
    log(`  登录状态：${client.loggedIn ? `已登录（${client.cookieSource}）` : "未登录"}`);
  });
  return httpServer;
}
