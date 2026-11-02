#!/usr/bin/env node
/**
 * 网易云音乐 MCP 服务器入口。
 *
 *   node dist/index.js                 # stdio 模式：Claude Desktop / Claude Code 本地使用
 *   node dist/index.js --http          # HTTP 模式：部署到服务器，作为 claude.ai 自定义连接器
 *
 * HTTP 模式环境变量：PORT（默认 8787）、HOST（默认 0.0.0.0）、MCP_AUTH_TOKEN（访问令牌）
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomBytes } from "node:crypto";
import { NeteaseClient } from "./client.js";
import { startHttp } from "./http.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./tools.js";

const log = (...args: unknown[]) => console.error(`[${SERVER_NAME}]`, ...args);

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function runStdio(client: NeteaseClient) {
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
  log(`stdio 模式已启动 v${SERVER_VERSION}，登录状态：${client.loggedIn ? `已登录（${client.cookieSource}）` : "未登录"}`);
}

async function main() {
  const client = new NeteaseClient();
  if (process.argv.includes("--http")) {
    let token = process.env.MCP_AUTH_TOKEN?.trim();
    if (!token) {
      token = randomBytes(24).toString("base64url");
      log("未设置 MCP_AUTH_TOKEN，已随机生成一个（仅本次运行有效）。正式部署请设置固定的 MCP_AUTH_TOKEN。");
    } else if (token.length < 16) {
      log("错误：MCP_AUTH_TOKEN 太短，至少需要 16 个字符。");
      process.exit(1);
    }
    startHttp(client, {
      port: Number(argValue("--port") ?? process.env.PORT ?? 8787),
      host: argValue("--host") ?? process.env.HOST ?? "0.0.0.0",
      token,
    });
  } else {
    await runStdio(client);
  }
}

main().catch((err) => {
  log("启动失败：", err);
  process.exit(1);
});
