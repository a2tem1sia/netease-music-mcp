# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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

[0.1.0]: https://github.com/a2tem1sia/netease-music-mcp/releases/tag/v0.1.0
