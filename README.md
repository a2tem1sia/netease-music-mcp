# 网易云音乐 MCP Connector（非官方）

让 Claude 直接访问网易云音乐：搜歌、看歌单 / 专辑 / 歌手 / 歌词 / 评论 / 排行榜，扫码登录后还能看每日推荐、"我喜欢的音乐"、听歌排行，以及新建歌单、往歌单里加歌、收藏歌曲。

> 本项目与网易公司无关。网易云音乐没有公开 API，这里用的是网页版 (music.163.com) 自己调用的接口，网易改接口时可能需要更新。

## 能做什么

| 分类 | 工具 | 说明 | 需要登录 |
|---|---|---|---|
| 搜索 | `search` | 歌曲 / 专辑 / 歌手 / 歌单 / 用户 / 按歌词搜歌 / 播客 | |
| 详情 | `get_song_detail` `get_album` `get_artist` `get_playlist` | 批量歌曲信息、专辑曲目、歌手简介 + 热门歌曲 + 专辑、歌单曲目（分页） | |
| 歌词 | `get_lyrics` | 原文 + 中文翻译 + 罗马音，可选保留时间轴 | |
| 发现 | `get_toplists` `get_similar_songs` `get_comments` | 官方排行榜、相似歌曲、热门评论 / 最新评论 | |
| 登录 | `login_qr_start` `login_qr_check` `get_login_status` `logout` | 扫码登录，登录状态自动保存 | |
| 我的 | `get_daily_recommendations` `get_recommended_playlists` `get_liked_songs` `get_user_playlists` `get_listening_history` | 每日推荐、推荐歌单、我喜欢的音乐、我的歌单、听歌排行 | ✅ |
| 修改 | `like_song` `create_playlist` `update_playlist_tracks` | 收藏 / 取消收藏、新建歌单、歌单加歌 / 删歌 | ✅ |

结果里的 `link` 是网页链接，点开就能在浏览器或 App 里播放。

## 安装

需要 [Node.js](https://nodejs.org) 18.17 或更新版本（用 `.mcpb` 一键安装时，Claude Desktop 会使用自带的 Node）。

### 方式一：Claude Desktop 一键安装（推荐）

1. 获取安装包：克隆本仓库后运行 `npm install && npm run pack:mcpb`，会生成 `netease-music-mcp-0.1.0.mcpb`。
2. 双击这个 `.mcpb` 文件，或者把它拖进 Claude Desktop 的 **设置 → 扩展** 页面。
3. 点 **安装**。Cookie 那一栏留空即可。
4. 在对话里说"**登录网易云**"，用网易云音乐 App 扫描二维码。

### 方式二：Claude Desktop 手动配置

先在项目目录运行 `npm install && npm run build`，然后编辑 `claude_desktop_config.json`（**设置 → 开发者 → 编辑配置**）：

```json
{
  "mcpServers": {
    "netease-music": {
      "command": "node",
      "args": ["/绝对路径/netease-music-mcp/dist/index.js"]
    }
  }
}
```

### 方式三：Claude Code

```bash
claude mcp add netease-music -- node /绝对路径/netease-music-mcp/dist/index.js
```

### 方式四：claude.ai 网页版 / 手机 App（远程连接器）

claude.ai 上的自定义连接器是从 Anthropic 的服务器访问你的连接器的，所以需要把它部署到一台**有公网 HTTPS 地址**的服务器上：

```bash
npm install && npm run build
MCP_AUTH_TOKEN="换成一串至少 16 位的随机字符" PORT=8787 node dist/index.js --http
```

再用 Caddy / Nginx 等反向代理加上 HTTPS，然后在 claude.ai 的 **设置 → 连接器 → 添加自定义连接器** 里填：

```
https://你的域名/mcp/<MCP_AUTH_TOKEN>
```

- 令牌就是访问密码，**拿到这个 URL 的人都能操作你的网易云账号**，不要外泄。也支持 `Authorization: Bearer <token>` 请求头，此时 URL 用 `/mcp`。
- 没设置 `MCP_AUTH_TOKEN` 时会随机生成一个并打印在日志里（只在本次运行有效）。
- 健康检查：`GET /healthz`。
- 服务器最好在中国大陆或网易云能正常访问的地区，否则部分接口可能受限。

## 登录

**扫码登录（推荐）**：对 Claude 说"登录网易云"。Claude 会调用 `login_qr_start` 显示二维码（图片，或者一段由方块字符组成的二维码），用网易云音乐 App 右上角的"扫一扫"扫码并在手机上确认，再让 Claude 检查登录状态。

如果看不到二维码图片：图片也保存在系统临时目录的 `netease-music-login-qr.png`（具体路径见返回结果中的 `qr_image_path`）。

**Cookie 登录（扫码被风控拦截时使用）**：

1. 用电脑浏览器登录 https://music.163.com
2. 按 F12 → **Application（应用）** → **Cookies** → `https://music.163.com`
3. 复制 `MUSIC_U` 的值
4. 填到扩展设置的"网易云 Cookie"里，或者设置环境变量 `NETEASE_COOKIE=<MUSIC_U 的值>`（也可以填完整的 Cookie 串）

登录状态保存在 `~/.netease-music-mcp/cookie.json`（权限 600，只有你自己能读），可以用环境变量 `NETEASE_COOKIE_FILE` 修改位置。说"退出网易云登录"会删除这个文件。

## 试试这样问

- "搜一下周杰伦的《晴天》，把歌词和翻译给我"
- "网易云热歌榜现在前 20 是哪些歌？"
- "看看我今天的每日推荐，挑 5 首适合写代码时听的"
- "分析一下我最近一周的听歌排行，我的口味是什么样的"
- "新建一个叫'雨天'的歌单，放 15 首安静的华语歌进去"
- "这首歌的热门评论都在说什么？"

修改类操作（收藏、建歌单、加歌）会改动你的真实账号，Claude 会先跟你确认。

## 隐私

- 连接器只和网易云音乐的服务器（`music.163.com`、`interfacepc.music.163.com`）通信，不会把数据发给其它第三方。
- 你的登录 Cookie 只保存在运行连接器的那台机器上。

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 扫码时提示"触发风控验证" (8821) | 网易云对接口登录做了限制，改用上面的 Cookie 登录。 |
| "需要登录网易云音乐" | 还没登录，或登录已过期（`MUSIC_U` 一般几周到几个月有效），重新扫码即可。 |
| "无法连接网易云音乐服务器" | 当前网络访问不了 `music.163.com`，检查网络 / 代理。 |
| 歌曲标记 `unavailable: true` | 该歌曲在网易云下架或没有版权。 |
| 某个接口返回错误码 | 网易可能改了接口，欢迎[提交 issue](https://github.com/a2tem1sia/netease-music-mcp/issues)。 |

## 开发

```bash
npm install
npm test            # 编译 + 运行测试（使用本地模拟的网易云服务器，不访问外网）
npm run pack:mcpb   # 生成 Claude Desktop 扩展 netease-music-mcp-<版本>.mcpb
npm run test:live   # 连真实的网易云逐个调用只读工具（不会修改账号）
                    #   加 NETEASE_COOKIE=<MUSIC_U> 可同时测试需要登录的接口
```

源码结构：

```
src/
  crypto.ts    weapi / eapi 请求加密
  client.ts    HTTP 客户端、cookie、weapi→eapi 自动回退
  cookies.ts   cookie 解析与保存
  format.ts    把原始返回精简成模型友好的结构
  tools.ts     全部 MCP 工具定义
  http.ts      Streamable HTTP 传输（远程连接器）
  index.ts     入口（默认 stdio，--http 为远程模式）
```

接口与加密参考了开源项目 NeteaseCloudMusicApi。

## 贡献者

- [@a2tem1sia](https://github.com/a2tem1sia)：作者、维护者
- [Claude](https://claude.com/claude-code)：AI 结对编程（通过 Claude Code）

欢迎提交 issue 和 pull request。
