// 打包 Gemini CLI 扩展：生成 Gemini CLI 从 GitHub Release 安装时会挑选的平台归档。
//   darwin.netease-music-mcp.tar.gz / linux.netease-music-mcp.tar.gz / win32.netease-music-mcp.zip
// Gemini CLI 按 "<platform>." 前缀匹配 Release 附件；连接器是纯 JavaScript，三个归档内容相同。
// 归档根目录必须直接包含 gemini-extension.json。
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const ext = JSON.parse(readFileSync(join(root, "gemini-extension.json"), "utf8"));
if (ext.version !== pkg.version) {
  throw new Error(`gemini-extension.json 版本 ${ext.version} 和 package.json 版本 ${pkg.version} 不一致`);
}
if (!existsSync(join(root, "dist", "index.js"))) throw new Error("请先运行 npm run build");

const stage = join(root, "build", "gemini");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
for (const f of ["gemini-extension.json", "GEMINI.md", "README.md", "LICENSE"]) cpSync(join(root, f), join(stage, f));
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", private: true, dependencies: pkg.dependencies }, null, 2),
);
execSync("npm install --omit=dev --no-audit --no-fund --ignore-scripts --no-package-lock", { cwd: stage, stdio: "inherit" });

const outputs = [];
for (const platform of ["darwin", "linux"]) {
  const file = `${platform}.${ext.name}.tar.gz`;
  rmSync(join(root, file), { force: true });
  execSync(`tar -czf "${join(root, file)}" -C "${stage}" .`, { stdio: "inherit" });
  outputs.push(file);
}
const zipFile = `win32.${ext.name}.zip`;
rmSync(join(root, zipFile), { force: true });
execSync(`zip -qr "${join(root, zipFile)}" .`, { cwd: stage, stdio: "inherit" });
outputs.push(zipFile);

console.log(`\n已生成 Gemini CLI 扩展归档（v${pkg.version}）：\n  ${outputs.join("\n  ")}`);
