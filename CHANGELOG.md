# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.3.0] - 2026-11-25

### 新增

- **Gemini CLI 扩展**：`gemini extensions install https://github.com/a2tem1sia/netease-music-mcp` 一条命令安装。包含 `gemini-extension.json`、`GEMINI.md`（使用说明）和可选的 Cookie 设置；Release 会附带 Gemini CLI 按平台挑选的 `darwin.` / `linux.` / `win32.` 归档（`npm run pack:gemini`）
- **ChatGPT 接入说明**：在开发者模式里把 HTTP 模式添加为远程连接器；连接器跑在自己电脑上并通过隧道暴露时，还能用 ChatGPT 控制电脑上的网易云播放
- **OpenAI Codex CLI** 配置说明；Gemini 网页版开发者模式的说明（尚未验证）

### 改进

- 工具参数里的 ID 改用 `minimum: 1` 而不是 `exclusiveMinimum`，兼容更多 MCP 客户端
- 歌词工具和服务器说明里提醒 AI 不要整段输出歌词原文

### 验证

- 用官方 Gemini CLI（0.71.1）安装扩展归档：扩展、MCP 服务器、`GEMINI.md` 均被识别，`gemini mcp list` 显示已连接
- ChatGPT、Gemini 网页版未实测（需要用户账号和公网地址）

## [0.2.0] - 2026-11-02

### 新增

- `get_recent_plays`：最近播放记录（所有设备，带播放时间），可以回答"我刚才在听什么"
- `play_in_app`（仅本地）：让电脑上的网易云客户端播放指定的歌曲 / 歌单 / 专辑 / 歌手 / 电台，使用网页版「在客户端播放」同款的 `orpheus://` 链接
- `playback_control`（仅本地）：通过系统媒体键控制播放 / 暂停、上一首、下一首、音量、静音（macOS / Windows / Linux）
- 环境变量 `NETEASE_LOCAL_CONTROL`：stdio 模式默认开启本机控制，HTTP 模式默认关闭（设为 `1` 开启）

### 验证

- macOS 实机：`play_in_app` 让网易云客户端直接开始播放；`playback_control` 的暂停、下一首可用
- Windows、Linux 仅模拟测试（检查发出的命令），尚未实机验证

### 研究记录

- 网易云的"接力播放"接口（`/api/relay/play/state/submit`）提交成功但手机、电脑客户端均无反应；"一起听"面向两个不同账号。目前没有可行的云端遥控手机的方法

## [0.1.1] - 2026-11-02

### 修复

- `get_liked_songs` 返回的顺序和 App 里“我喜欢的音乐”不一致：`/api/song/like/get` 的 ID 没有固定顺序。现在改为读取“我喜欢的音乐”歌单，最近喜欢的在前，并附带喜欢日期 `liked_at`；读不到歌单时才回退，并标注“顺序未知”
- 批量获取歌曲详情时按请求的 ID 顺序重新排列（接口不保证顺序），影响 `get_playlist` 等工具

### 验证

- 修改账号的 3 个工具（`create_playlist`、`update_playlist_tracks`、`like_song`）已在真实账号上验证：新建私密歌单、加歌、重复添加报错、删歌、收藏 / 取消收藏，测试后账号还原
- 21 个工具现在全部在真实网易云服务器上验证过

## [0.1.0] - 2026-11-02

首个版本。

### 新增

- 21 个 MCP 工具：搜索（歌曲 / 专辑 / 歌手 / 歌单 / 用户 / 歌词 / 播客）、歌曲 / 专辑 / 歌手 / 歌单详情、歌词（含翻译和罗马音）、评论、排行榜、相似歌曲、扫码登录、每日推荐、推荐歌单、我喜欢的音乐、用户歌单、听歌排行、收藏歌曲、新建歌单、歌单增删歌曲
- stdio 模式（Claude Desktop / Claude Code）和 Streamable HTTP 模式（claude.ai 远程连接器，令牌鉴权）
- Claude Desktop 扩展打包（`npm run pack:mcpb`）
- 本地模拟服务器测试（`npm test`）和真实服务器在线测试（`npm run test:live`）

### 修复

- 境外网络下登录后搜索结果为空：网易云会对境外 IP 返回加密结果，现在会自动换用其它接口
- 升级 zod 到 4.x，修复 GHSA-mrhx-c7xc-m3w5（校验超大数组时内存耗尽）

[0.3.0]: https://github.com/a2tem1sia/netease-music-mcp/releases/tag/v0.3.0
[0.2.0]: https://github.com/a2tem1sia/netease-music-mcp/releases/tag/v0.2.0
[0.1.1]: https://github.com/a2tem1sia/netease-music-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/a2tem1sia/netease-music-mcp/releases/tag/v0.1.0
