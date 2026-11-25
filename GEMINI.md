# 网易云音乐（netease-music 扩展）

这个扩展通过 `netease-music` MCP 服务器访问网易云音乐（music.163.com）。本项目与网易公司无关。

## 使用方式

- 歌曲、歌单、专辑、歌手都用数字 ID 标识。先用 `search` 找到 ID，再用 `get_*` 工具查看详情。
- 排行榜（飙升榜、热歌榜等）本质上是歌单：`get_toplists` 拿到榜单 ID 后用 `get_playlist` 查看曲目。
- 需要登录的功能（每日推荐、我喜欢的音乐、我的歌单、听歌排行、最近播放、收藏 / 建歌单）要先登录：
  调用 `login_qr_start` 获得二维码，把返回的 `qr_text` 原样放进代码块展示给用户（或告诉用户 `qr_image_path` 里的图片路径），
  请用户用网易云音乐 App 扫码并确认，然后调用 `login_qr_check`。
- 结果里的 `link` 是网页链接，可以直接给用户点开播放。
- 修改类操作（`like_song`、`create_playlist`、`update_playlist_tracks`）会改动用户的真实账号，执行前先向用户确认。

## 控制播放（扩展运行在用户自己的电脑上）

- 用户说“放一首……”“播放我的……歌单”时：先用 `search` / `get_user_playlists` 找到 ID，再调用 `play_in_app` 让电脑上的网易云客户端播放。
- “暂停”“继续”“下一首”“上一首”“声音大/小一点”：调用 `playback_control`。它发送系统媒体键，作用于系统当前正在播放的应用。
- macOS 上第一次使用 `playback_control` 如果提示需要授权，请用户到“系统设置 → 隐私与安全性 → 辅助功能”里允许运行 Gemini CLI 的终端 App，然后再试。
- “我刚才在听什么”：调用 `get_recent_plays`（播放记录通常晚几分钟）。

## 不要做的事

- 不要输出完整的歌词原文；需要时引用一两句或概括。
- 不要向用户索要或在对话里展示 Cookie、`MUSIC_U` 等登录凭证。
