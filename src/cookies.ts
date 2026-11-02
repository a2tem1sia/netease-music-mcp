/**
 * 登录 Cookie 的读取与持久化。
 *
 * 来源优先级：
 *   1. 环境变量 NETEASE_COOKIE（可填完整 Cookie 串，或只填 MUSIC_U 的值）
 *   2. 扫码登录后保存的文件（默认 ~/.netease-music-mcp/cookie.json，可用 NETEASE_COOKIE_FILE 修改）
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CookieJar = Record<string, string>;

export function parseCookieString(raw: string): CookieJar {
  const jar: CookieJar = {};
  const text = raw.trim();
  if (!text) return jar;
  // 只给了一个值（没有 '='）时，视为 MUSIC_U
  if (!text.includes("=")) {
    jar.MUSIC_U = text;
    return jar;
  }
  for (const part of text.split(/;\s*/)) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) jar[key] = value;
  }
  return jar;
}

/** 解析响应里的 Set-Cookie 头，忽略 Path/Expires 等属性以及已被删除的 cookie。 */
export function parseSetCookie(headers: string[]): CookieJar {
  const jar: CookieJar = {};
  for (const header of headers) {
    const first = header.split(";")[0];
    const idx = first.indexOf("=");
    if (idx <= 0) continue;
    const key = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (/max-age=0\b/i.test(header) || value === "" || value === "deleted") continue;
    jar[key] = value;
  }
  return jar;
}

export function serializeCookie(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export function cookieFilePath(): string {
  return process.env.NETEASE_COOKIE_FILE || join(homedir(), ".netease-music-mcp", "cookie.json");
}

export function loadInitialCookie(): { jar: CookieJar; source: "env" | "file" | "none" } {
  const env = process.env.NETEASE_COOKIE?.trim();
  // mcpb 的 user_config 未填写时会原样传入 "${user_config.xxx}"，这里忽略
  if (env && !env.startsWith("${")) return { jar: parseCookieString(env), source: "env" };
  try {
    const saved = JSON.parse(readFileSync(cookieFilePath(), "utf8"));
    if (saved && typeof saved === "object" && saved.cookie) {
      return { jar: parseCookieString(String(saved.cookie)), source: "file" };
    }
  } catch {
    /* 没有保存过 */
  }
  return { jar: {}, source: "none" };
}

export function saveCookie(jar: CookieJar): string {
  const file = cookieFilePath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ cookie: serializeCookie(jar), savedAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
  return file;
}

export function deleteSavedCookie(): void {
  rmSync(cookieFilePath(), { force: true });
}
