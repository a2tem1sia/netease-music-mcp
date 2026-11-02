// 打包 Claude Desktop 扩展 (.mcpb)：暂存 dist + 生产依赖，自动从服务器读取工具列表写入 manifest。
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "build", "mcpb");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, `netease-music-mcp-${pkg.version}.mcpb`);

// 1. 从实际服务器读取工具名称和描述
const { NeteaseClient } = await import(join(root, "dist/client.js"));
const { createServer } = await import(join(root, "dist/tools.js"));
const server = createServer(new NeteaseClient({ jar: {} }));
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "pack", version: "1" });
await Promise.all([server.connect(a), client.connect(b)]);
const { tools } = await client.listTools();
await client.close();

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
delete manifest.$schema;
manifest.version = pkg.version;
manifest.tools = tools.map((t) => ({ name: t.name, description: t.description }));

// 2. 暂存目录
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
cpSync(join(root, "README.md"), join(stage, "README.md"));
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", private: true, dependencies: pkg.dependencies }, null, 2),
);
execSync("npm install --omit=dev --no-audit --no-fund --ignore-scripts", { cwd: stage, stdio: "inherit" });

// 3. 校验并打包
const mcpb = join(root, "node_modules", ".bin", "mcpb");
execSync(`"${mcpb}" validate "${join(stage, "manifest.json")}"`, { stdio: "inherit" });
execSync(`"${mcpb}" pack "${stage}" "${out}"`, { stdio: "inherit" });
console.log(`\n已生成 ${out}（${tools.length} 个工具）`);
