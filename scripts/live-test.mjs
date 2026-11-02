// 对真实的网易云音乐服务器逐个调用只读工具，检查连接器是否可用。
// 不会执行任何修改账号的操作（收藏 / 建歌单 / 加歌）。
//
//   npm run build && node scripts/live-test.mjs           # 公开接口
//   node scripts/live-test.mjs --qr                       # 另外测试生成登录二维码
//   NETEASE_COOKIE=<MUSIC_U> node scripts/live-test.mjs   # 另外测试需要登录的接口（也会读取扫码保存的登录状态）
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { NeteaseClient } = await import(join(root, "dist/client.js"));
const { createServer } = await import(join(root, "dist/tools.js"));

const netease = new NeteaseClient();
const server = createServer(netease);
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "live-test", version: "1.0.0" });
await Promise.all([server.connect(a), client.connect(b)]);

const results = [];
const verbose = process.argv.includes("--verbose");

async function step(label, tool, args, check) {
  const started = Date.now();
  let status = "PASS";
  let note = "";
  let data;
  try {
    const res = await client.callTool({ name: tool, arguments: args });
    const text = res.content.find((c) => c.type === "text")?.text ?? "";
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (res.isError) {
      status = "FAIL";
      note = String(text).slice(0, 160);
    } else {
      note = check ? String(check(data, res) ?? "") : "";
    }
  } catch (err) {
    // 工具调用异常，或 check 判定返回内容不符合预期
    status = "FAIL";
    note = err instanceof Error ? err.message : String(err);
  }
  const ms = Date.now() - started;
  results.push({ label, tool, status, ms, note });
  console.log(`${status === "PASS" ? "✅" : "❌"} ${label.padEnd(22)} ${String(ms).padStart(5)}ms  ${note}`);
  if (verbose && data) console.log(JSON.stringify(data, null, 2).slice(0, 1500));
  return status === "PASS" ? data : undefined;
}

const expect = (cond, okNote, failNote = "返回内容不符合预期") => {
  if (!cond) throw new Error(failNote);
  return okNote;
};

console.log(`网易云音乐连接器在线测试 · 登录状态：${netease.loggedIn ? `已登录（${netease.cookieSource}）` : "未登录"}\n`);

// ---------- 公开接口 ----------
const search = await step("搜索歌曲", "search", { keywords: "晴天 周杰伦", limit: 5 }, (d) =>
  expect(d.songs?.length > 0, `共 ${d.total} 条，第一首：${d.songs?.[0]?.name} - ${d.songs?.[0]?.artists}`, "没有搜到歌曲"),
);
const song = search?.songs?.[0];

await step("搜索歌手", "search", { keywords: "周杰伦", type: "artist", limit: 3 }, (d) =>
  expect(d.artists?.length > 0, `${d.artists?.[0]?.name} (id ${d.artists?.[0]?.id})`),
);
await step("搜索歌单", "search", { keywords: "华语经典", type: "playlist", limit: 3 }, (d) =>
  expect(d.playlists?.length > 0, d.playlists?.[0]?.name),
);
await step("搜索专辑", "search", { keywords: "叶惠美", type: "album", limit: 3 }, (d) =>
  expect(d.albums?.length > 0, `${d.albums?.[0]?.name} - ${d.albums?.[0]?.artists}`),
);
await step("按歌词搜歌", "search", { keywords: "故事的小黄花", type: "lyric", limit: 3 }, (d) =>
  expect(d.songs?.length > 0, `${d.songs?.[0]?.name} - ${d.songs?.[0]?.artists}`),
);
await step("搜索用户", "search", { keywords: "云音乐", type: "user", limit: 3 }, (d) =>
  expect(d.users?.length > 0, d.users?.[0]?.nickname),
);
await step("搜索播客", "search", { keywords: "故事", type: "podcast", limit: 3 }, (d) =>
  expect(d.podcasts?.length > 0, d.podcasts?.[0]?.name),
);

if (song) {
  await step("歌曲详情", "get_song_detail", { ids: [song.id] }, (d) =>
    expect(d.songs?.[0]?.id === song.id, `${d.songs[0].name} · ${d.songs[0].album} · ${d.songs[0].duration}`),
  );
  await step("歌词", "get_lyrics", { id: song.id }, (d) =>
    expect(d.lyric || d.instrumental, (d.lyric ?? "纯音乐").split("\n").slice(0, 2).join(" / ")),
  );
  await step("相似歌曲", "get_similar_songs", { id: song.id, limit: 5 }, (d) =>
    expect(Array.isArray(d.songs), `${d.songs.length} 首` + (d.songs[0] ? `，如 ${d.songs[0].name}` : "")),
  );
  await step("歌曲评论", "get_comments", { id: song.id, limit: 3 }, (d) =>
    expect(d.total > 0, `共 ${d.total} 条，热评 ${d.hot_comments?.length ?? 0} 条`),
  );
  if (song.album_id) {
    await step("专辑详情", "get_album", { id: song.album_id }, (d) =>
      expect(d.album?.name && d.songs?.length > 0, `${d.album.name}（${d.album.publish_date}，${d.songs.length} 首）`),
    );
  }
  if (song.artist_ids?.[0]) {
    await step("歌手详情 + 专辑", "get_artist", { id: song.artist_ids[0], top_songs: 5, include_albums: true, album_limit: 5 }, (d) =>
      expect(d.artist?.name && d.hot_songs?.length > 0, `${d.artist.name}：热门 ${d.hot_songs.length} 首，专辑 ${d.albums?.length ?? 0} 张`),
    );
  }
}

const toplists = await step("排行榜列表", "get_toplists", {}, (d) =>
  expect(d.toplists?.length > 0, `${d.toplists.length} 个榜单，如 ${d.toplists.slice(0, 3).map((t) => t.name).join("、")}`),
);
if (toplists?.toplists?.[0]) {
  const top = toplists.toplists[0];
  await step("歌单详情（榜单）", "get_playlist", { id: top.id, limit: 5 }, (d) =>
    expect(d.tracks?.length > 0, `${d.playlist?.name}：共 ${d.total_tracks} 首，第一名 ${d.tracks[0].name} - ${d.tracks[0].artists}`),
  );
  await step("歌单分页", "get_playlist", { id: top.id, limit: 3, offset: 10 }, (d) =>
    expect(d.tracks?.length > 0 && d.offset === 10, `第 11-${10 + d.tracks.length} 首`),
  );
}

// ---------- 登录 ----------
await step("登录状态", "get_login_status", {}, (d) =>
  d.logged_in ? `已登录：${d.nickname}${d.vip ? "（VIP）" : ""}` : "未登录",
);

if (process.argv.includes("--qr")) {
  await step("生成登录二维码", "login_qr_start", {}, (d, res) =>
    expect(d.login_key && res.content.some((c) => c.type === "image"), `login_key=${d.login_key}，图片已保存到 ${d.qr_image_path}`),
  );
}

if (netease.loggedIn) {
  await step("每日推荐", "get_daily_recommendations", {}, (d) =>
    expect(d.songs?.length > 0, `${d.songs.length} 首，如 ${d.songs[0].name}${d.songs[0].reason ? `（${d.songs[0].reason}）` : ""}`),
  );
  await step("推荐歌单", "get_recommended_playlists", {}, (d) =>
    expect(Array.isArray(d.playlists), `${d.playlists.length} 个`),
  );
  await step("我喜欢的音乐", "get_liked_songs", { limit: 5 }, (d) =>
    expect(
      typeof d.total === "number" && d.order === "最近喜欢的在前" && d.songs[0]?.liked_at,
      `共 ${d.total} 首，最近喜欢：${d.songs[0]?.name}（${d.songs[0]?.liked_at}）`,
      "没有按喜欢时间排序",
    ),
  );
  await step("我的歌单", "get_user_playlists", { limit: 5 }, (d) =>
    expect(d.playlists?.length > 0, `${d.playlists.length} 个，如 ${d.playlists[0].name}`),
  );
  await step("最近播放", "get_recent_plays", { limit: 3 }, (d) =>
    expect(d.songs?.length > 0 && d.songs[0].played_at, `最近一首：${d.songs?.[0]?.name}（${d.songs?.[0]?.ago}）`),
  );
  await step("听歌排行（周）", "get_listening_history", { period: "week", limit: 5 }, (d) =>
    expect(Array.isArray(d.songs), `${d.songs.length} 首` + (d.songs[0] ? `，第一 ${d.songs[0].name}` : "")),
  );
} else {
  console.log("\n（未登录，跳过个人数据测试。设置 NETEASE_COOKIE 或先扫码登录后可测试。）");
}

const failed = results.filter((r) => r.status !== "PASS");
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("失败项：");
  for (const f of failed) console.log(`  - ${f.label} (${f.tool})：${f.note}`);
}
await client.close();
process.exit(failed.length ? 1 : 0);

