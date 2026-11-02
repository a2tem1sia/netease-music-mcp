// 端到端测试：通过 MCP SDK 客户端调用工具，网易云服务器用本地假服务替代。
// 假服务会真正解密 weapi / eapi 请求体，从而同时验证加密、路由和返回格式化。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const tmp = mkdtempSync(join(tmpdir(), "netease-mcp-test-"));
process.env.NETEASE_COOKIE_FILE = join(tmp, "cookie.json");
delete process.env.NETEASE_COOKIE;

const { NeteaseClient } = await import("../dist/client.js");
const { createServer } = await import("../dist/tools.js");
const { startHttp } = await import("../dist/http.js");
const { weapiDecrypt, eapiDecrypt } = await import("../dist/crypto.js");
const { parseCookieString, parseSetCookie } = await import("../dist/cookies.js");

const KEY = "testKey123456789";

/** 简易假网易云服务器。routes: { "/weapi/xxx": (data, ctx) => body | {body, headers} } */
function fakeNetease(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const form = new URLSearchParams(init.body);
    let data;
    let crypto;
    if (u.pathname.startsWith("/weapi/")) {
      crypto = "weapi";
      assert.equal(u.host, "music.163.com");
      assert.match(form.get("encSecKey"), /^[0-9a-f]{256}$/);
      data = weapiDecrypt(form.get("params"), KEY);
    } else if (u.pathname.startsWith("/eapi/")) {
      crypto = "eapi";
      assert.equal(u.host, "interfacepc.music.163.com");
      const dec = eapiDecrypt(form.get("params"));
      assert.equal(dec.uri, "/api/" + u.pathname.slice(6));
      data = dec.data;
    } else throw new Error("unexpected url " + url);
    const call = { path: u.pathname, crypto, data, cookie: init.headers.Cookie, headers: init.headers };
    calls.push(call);
    const handler = routes[u.pathname];
    if (!handler) return new Response(JSON.stringify({ code: 404, msg: "no route " + u.pathname }), { status: 200 });
    const out = await handler(data, call, calls);
    const body = out && out.__raw ? out.body : out;
    const headers = new Headers({ "content-type": "application/json" });
    for (const c of out?.setCookie ?? []) headers.append("set-cookie", c);
    return new Response(JSON.stringify(body), { status: 200, headers });
  };
  return { fetch, calls };
}

async function connect(routes, clientOpts = {}, serverOpts = {}) {
  const fake = fakeNetease(routes);
  const netease = new NeteaseClient({ fetch: fake.fetch, secretKey: () => KEY, jar: {}, ...clientOpts });
  const server = createServer(netease, serverOpts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content.find((c) => c.type === "text")?.text;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { res, data: parsed };
  };
  return { client, call, calls: fake.calls, netease };
}

const SONG = (id, name) => ({
  id,
  name,
  ar: [{ id: 6452, name: "周杰伦" }],
  al: { id: 18915, name: "叶惠美", picUrl: "x" },
  dt: 269000,
  fee: 1,
  alia: [],
});

test("cookie 解析", () => {
  assert.deepEqual(parseCookieString("abc123"), { MUSIC_U: "abc123" });
  assert.deepEqual(parseCookieString("MUSIC_U=a=b; __csrf=c"), { MUSIC_U: "a=b", __csrf: "c" });
  assert.deepEqual(
    parseSetCookie(["MUSIC_U=xyz; Max-Age=1296000; Path=/", "__csrf=tok; Path=/", "MUSIC_R_T=; Max-Age=0"]),
    { MUSIC_U: "xyz", __csrf: "tok" },
  );
});

test("工具列表", async () => {
  const { client } = await connect({});
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "create_playlist", "get_album", "get_artist", "get_comments", "get_daily_recommendations",
    "get_liked_songs", "get_listening_history", "get_login_status", "get_lyrics", "get_playlist",
    "get_recent_plays", "get_recommended_playlists", "get_similar_songs", "get_song_detail", "get_toplists", "get_user_playlists",
    "like_song", "login_qr_check", "login_qr_start", "logout", "search", "update_playlist_tracks",
  ]);
  assert.ok(!names.includes("play_in_app") && !names.includes("playback_control"), "默认（远程）模式不提供本机控制");
  const search = tools.find((t) => t.name === "search");
  assert.equal(search.inputSchema.properties.type.default, "song");
  assert.equal(search.annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "update_playlist_tracks").annotations.destructiveHint, true);
});

test("search：歌曲（PC 接口 eapi cloudsearch/pc）", async () => {
  const { call, calls } = await connect({
    "/eapi/cloudsearch/pc": (d) => {
      assert.equal(d.s, "晴天");
      assert.equal(d.type, 1);
      assert.equal(d.limit, 5);
      assert.equal(d.header.os, "pc");
      return { code: 200, result: { songCount: 300, songs: [{ ...SONG(186016, "晴天"), privilege: { st: 0 } }] } };
    },
  });
  const { data } = await call("search", { keywords: "晴天", limit: 5 });
  assert.deepEqual(calls.map((c) => c.path), ["/eapi/cloudsearch/pc"]);
  assert.equal(data.total, 300);
  assert.deepEqual(data.songs[0], {
    id: 186016,
    name: "晴天",
    artists: "周杰伦",
    artist_ids: [6452],
    album: "叶惠美",
    album_id: 18915,
    duration: "4:29",
    fee: "VIP",
    link: "https://music.163.com/#/song?id=186016",
  });
});

test("search：PC 接口失败 / 返回境外加密结果时回退到网页版 search/get", async () => {
  for (const eapiReply of [{ code: 400, msg: "bad" }, { code: 200, abroad: true, result: "35b174dd82395f39" }]) {
    const { call, calls } = await connect({
      "/eapi/cloudsearch/pc": () => eapiReply,
      "/weapi/search/get": (d) => {
        assert.equal(d.type, 1000);
        return { code: 200, result: { playlistCount: 1, playlists: [{ id: 1, name: "华语", creator: { nickname: "x", userId: 2 }, trackCount: 10, playCount: 99 }] } };
      },
    });
    const { res, data } = await call("search", { keywords: "华语", type: "playlist" });
    assert.equal(res.isError, undefined);
    assert.deepEqual(calls.map((c) => c.path), ["/eapi/cloudsearch/pc", "/weapi/search/get"]);
    assert.equal(data.playlists[0].name, "华语");
    assert.equal(data.playlists[0].link, "https://music.163.com/#/playlist?id=1");
  }
});

test("境外加密结果：有备用接口时自动回退，没有时给出明确提示", async () => {
  const { call, calls } = await connect({
    "/weapi/toplist": () => ({ code: 200, abroad: true, result: "abcdef0123" }),
    "/eapi/toplist": () => ({ code: 200, list: [{ id: 3778678, name: "热歌榜" }] }),
    "/weapi/v1/album/1": () => ({ code: 200, abroad: true, result: "abcdef0123" }),
  });
  const top = await call("get_toplists");
  assert.deepEqual(calls.map((c) => c.crypto), ["weapi", "eapi"]);
  assert.equal(top.data.toplists[0].name, "热歌榜");
  const album = await call("get_album", { id: 1 });
  assert.equal(album.res.isError, true);
  assert.match(album.data, /境外/);
});

test("get_playlist：trackIds 分页 + 批量歌曲详情", async () => {
  const ids = Array.from({ length: 120 }, (_, i) => ({ id: 1000 + i }));
  const { call } = await connect({
    "/weapi/v6/playlist/detail": (d) => {
      assert.equal(d.id, 3778678);
      return { code: 200, playlist: { id: 3778678, name: "热歌榜", trackCount: 120, trackIds: ids, tracks: [] } };
    },
    "/weapi/v3/song/detail": (d) => {
      const wanted = JSON.parse(d.c).map((x) => x.id);
      assert.deepEqual(wanted, [1100, 1101, 1102, 1103, 1104, 1105, 1106, 1107, 1108, 1109]);
      return { code: 200, songs: wanted.map((x) => SONG(x, "s" + x)), privileges: [{ id: 1100, st: -200 }] };
    },
  });
  const { data } = await call("get_playlist", { id: "3778678", limit: 10, offset: 100 });
  assert.equal(data.total_tracks, 120);
  assert.equal(data.tracks.length, 10);
  assert.equal(data.tracks[0].unavailable, true);
  assert.equal(data.has_more, true);
});

test("get_lyrics：去除时间轴，附带翻译", async () => {
  const { call } = await connect({
    "/weapi/song/lyric": (d, c) => {
      assert.equal(d.id, 186016);
      assert.match(c.cookie, /_ntes_nuid=[0-9a-f]{32}/);
      assert.match(c.cookie, /NMTID=00O/);
      assert.equal(c.headers.Referer, "https://music.163.com");
      return {
        code: 200,
        lrc: { lyric: '{"t":0,"c":[{"tx":"作词: 周杰伦"}]}\n[00:01.00]故事的小黄花\n[00:05.20]从出生那年就飘着\n' },
        tlyric: { lyric: "" },
      };
    },
  });
  const { data } = await call("get_lyrics", { id: 186016 });
  assert.equal(data.lyric, "故事的小黄花\n从出生那年就飘着");
  assert.equal(data.translation, undefined);
});

test("get_toplists：weapi 被拒时回退到 eapi，eapi 带客户端 header", async () => {
  const { call, calls } = await connect({
    "/weapi/toplist": () => ({ code: -462, message: "risk" }),
    "/eapi/toplist": (d, c) => {
      assert.equal(d.e_r, false);
      assert.equal(d.header.os, "pc");
      assert.match(d.header.requestId, /^\d+_\d{4}$/);
      assert.match(c.cookie, /deviceId=[0-9A-F]{32}/);
      return { code: 200, list: [{ id: 19723756, name: "飙升榜", updateFrequency: "每天更新", updateTime: 1730000000000 }] };
    },
  });
  const { data } = await call("get_toplists");
  assert.deepEqual(calls.map((c) => c.crypto), ["weapi", "eapi"]);
  assert.deepEqual(data.toplists[0], { id: 19723756, name: "飙升榜", update_frequency: "每天更新", updated: "2024-10-27" });
});

test("未登录时调用个人功能：返回明确提示", async () => {
  const { call, calls } = await connect({});
  const { res, data } = await call("get_daily_recommendations");
  assert.equal(res.isError, true);
  assert.match(data, /需要登录/);
  assert.equal(calls.length, 0);
  const status = await call("get_login_status");
  assert.equal(status.data.logged_in, false);
});

test("扫码登录全流程：生成二维码 → 等待 → 成功并保存 cookie → 个人数据", async () => {
  let checks = 0;
  const { call, calls, netease } = await connect({
    "/weapi/login/qrcode/unikey": (d) => {
      assert.equal(d.type, 1);
      return { code: 200, unikey: "uk-123" };
    },
    "/weapi/login/qrcode/client/login": (d) => {
      assert.equal(d.key, "uk-123");
      checks++;
      if (checks === 1) return { code: 801, message: "等待扫码" };
      return {
        __raw: true,
        body: { code: 803, message: "授权登陆成功" },
        setCookie: ["MUSIC_U=secret-music-u; Max-Age=1296000; Path=/", "__csrf=csrf-tok; Path=/"],
      };
    },
    "/weapi/w/nuser/account/get": (d, c) => {
      assert.match(c.cookie, /MUSIC_U=secret-music-u/);
      assert.equal(d.csrf_token, "csrf-tok");
      return { code: 200, account: { id: 42, vipType: 11 }, profile: { userId: 42, nickname: "测试用户" } };
    },
    "/weapi/v3/discovery/recommend/songs": () => ({
      code: 200,
      data: { dailySongs: [SONG(1, "推荐歌")], recommendReasons: [{ songId: 1, reason: "根据你喜欢的周杰伦推荐" }] },
    }),
  });

  const start = await call("login_qr_start");
  const image = start.res.content.find((c) => c.type === "image");
  assert.equal(image.mimeType, "image/png");
  assert.ok(Buffer.from(image.data, "base64").subarray(1, 4).toString() === "PNG");
  assert.equal(start.data.login_key, "w:uk-123");
  assert.equal(start.data.qr_url, "https://music.163.com/login?codekey=uk-123");
  assert.match(start.data.qr_text, /█/);

  const check = await call("login_qr_check", { login_key: "w:uk-123", wait_seconds: 5 });
  assert.equal(check.data.status, "success");
  assert.match(check.data.message, /测试用户/);
  assert.equal(checks, 2);
  assert.ok(netease.loggedIn);

  const saved = JSON.parse(readFileSync(process.env.NETEASE_COOKIE_FILE, "utf8"));
  assert.match(saved.cookie, /MUSIC_U=secret-music-u/);
  if (process.platform !== "win32") {
    const { statSync } = await import("node:fs");
    assert.equal(statSync(process.env.NETEASE_COOKIE_FILE).mode & 0o777, 0o600);
  }

  const status = await call("get_login_status");
  assert.equal(status.data.logged_in, true);
  assert.equal(status.data.nickname, "测试用户");
  assert.equal(status.data.vip, true);

  const daily = await call("get_daily_recommendations");
  assert.equal(daily.data.songs[0].reason, "根据你喜欢的周杰伦推荐");

  // 新进程启动时能从文件恢复登录状态
  const restored = new NeteaseClient({ fetch: async () => { throw new Error("no"); } });
  assert.equal(restored.loggedIn, true);
  assert.equal(restored.cookieSource, "file");

  await call("logout");
  assert.equal(existsSync(process.env.NETEASE_COOKIE_FILE), false);
  assert.ok(calls.length > 0);
});

test("get_liked_songs：按“我喜欢的音乐”歌单顺序（最近喜欢在前），附带喜欢日期", async () => {
  const day = (d) => Date.UTC(2026, 10, d);
  const { call } = await connect(
    {
      "/weapi/w/nuser/account/get": () => ({ code: 200, account: { id: 42 }, profile: { userId: 42 } }),
      "/weapi/user/playlist": () => ({ code: 200, playlist: [{ id: 900, specialType: 5, name: "x喜欢的音乐", creator: { userId: 42 } }, { id: 901, specialType: 0 }] }),
      "/weapi/v6/playlist/detail": (d) => {
        assert.equal(d.id, 900);
        return { code: 200, playlist: { id: 900, trackIds: [{ id: 3, at: day(2) }, { id: 1, at: day(1) }, { id: 2, at: day(1) - 86400000 }] } };
      },
      // 故意乱序返回，验证按请求顺序重排
      "/weapi/v3/song/detail": (d) => {
        const ids = JSON.parse(d.c).map((x) => x.id);
        return { code: 200, songs: [...ids].reverse().map((x) => SONG(x, "s" + x)) };
      },
      "/weapi/song/like/get": () => {
        throw new Error("有歌单时不应调用无序的 like/get");
      },
    },
    { jar: { MUSIC_U: "u" } },
  );
  const { data } = await call("get_liked_songs", { limit: 2 });
  assert.equal(data.total, 3);
  assert.equal(data.order, "最近喜欢的在前");
  assert.deepEqual(data.songs.map((s) => [s.id, s.liked_at]), [[3, "2026-11-02"], [1, "2026-11-01"]]);
  assert.equal(data.has_more, true);
});

test("get_liked_songs：读不到歌单时回退到 like/get，并标注顺序未知", async () => {
  const { call } = await connect(
    {
      "/weapi/user/playlist": () => ({ code: 200, playlist: [] }),
      "/weapi/song/like/get": (d) => {
        assert.equal(d.uid, 7);
        return { code: 200, ids: [5, 6] };
      },
      "/weapi/v3/song/detail": (d) => ({ code: 200, songs: JSON.parse(d.c).map((x) => SONG(x.id, "s" + x.id)) }),
    },
    { jar: { MUSIC_U: "u" } },
  );
  const { data } = await call("get_liked_songs", { uid: 7 });
  assert.equal(data.order, "顺序未知");
  assert.deepEqual(data.songs.map((s) => s.id), [5, 6]);
  assert.equal(data.songs[0].liked_at, undefined);
});

test("扫码登录：风控 8821 时给出替代方案", async () => {
  const { call } = await connect({
    "/weapi/login/qrcode/client/login": () => ({ code: 8821, message: "需要行为验证码验证" }),
  });
  const { data } = await call("login_qr_check", { login_key: "w:k", wait_seconds: 0 });
  assert.equal(data.status, "blocked");
  assert.match(data.message, /NETEASE_COOKIE/);
});

test("update_playlist_tracks：512 时重复 ID 重试", async () => {
  const sent = [];
  const { call } = await connect(
    {
      "/weapi/w/nuser/account/get": () => ({ code: 200, account: { id: 42 }, profile: { userId: 42 } }),
      "/weapi/playlist/manipulate/tracks": (d) => {
        sent.push(JSON.parse(d.trackIds));
        assert.equal(d.op, "add");
        assert.equal(d.pid, 777);
        return sent.length === 1 ? { code: 512, message: "x" } : { code: 200, count: 2 };
      },
    },
    { jar: { MUSIC_U: "u", __csrf: "c" } },
  );
  const { res, data } = await call("update_playlist_tracks", { playlist_id: 777, song_ids: [1, 2] });
  assert.equal(res.isError, undefined);
  assert.equal(data.success, true);
  assert.deepEqual(sent, [["1", "2"], ["1", "2", "1", "2"]]);
});

test("网络错误：给出可读的提示", async () => {
  const netease = new NeteaseClient({ jar: {}, fetch: async () => { throw new TypeError("fetch failed"); } });
  const server = createServer(netease);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const res = await client.callTool({ name: "get_album", arguments: { id: 1 } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /无法连接网易云音乐服务器 \(music\.163\.com\)/);
});

test("get_recent_plays：最近播放 + 播放时间", async () => {
  const now = Date.now();
  const { call } = await connect(
    {
      "/weapi/w/nuser/account/get": () => ({ code: 200, account: { id: 42 }, profile: { userId: 42 } }),
      "/weapi/play-record/song/list": (d) => {
        assert.equal(d.limit, 2);
        return { code: 200, data: { total: 3, list: [
          { playTime: now - 3 * 60000, data: SONG(1, "刚放的") },
          { playTime: now - 2 * 3600000, data: SONG(2, "两小时前") },
          { playTime: now - 3 * 86400000, data: SONG(3, "多余的") },
        ] } };
      },
    },
    { jar: { MUSIC_U: "u" } },
  );
  const { data } = await call("get_recent_plays", { limit: 2 });
  assert.deepEqual(data.songs.map((s) => [s.name, s.ago]), [["刚放的", "3 分钟前"], ["两小时前", "2 小时前"]]);
  assert.match(data.songs[0].played_at, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
});

function fakeRunner(stdout = "ok") {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    return { stdout: typeof stdout === "function" ? stdout(cmd, args) : stdout, stderr: "" };
  };
  return { run, calls };
}

test("本机控制：只在本地模式出现，说明文字随模式变化", async () => {
  const local = await connect({}, {}, { localControl: true, platform: "darwin", run: fakeRunner().run });
  const names = (await local.client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("play_in_app") && names.includes("playback_control"));
  assert.equal(names.length, 24);
  assert.match(local.client.getInstructions(), /play_in_app/);
  const remote = await connect({});
  assert.match(remote.client.getInstructions(), /远程模式/);
});

test("play_in_app：用网页版同款 orpheus 链接让客户端播放", async () => {
  const { run, calls } = fakeRunner();
  const { call } = await connect(
    { "/weapi/v3/song/detail": () => ({ code: 200, songs: [SONG(208902, "红色高跟鞋")] }) },
    {},
    { localControl: true, platform: "darwin", run },
  );
  const { data } = await call("play_in_app", { id: 208902 });
  assert.equal(data.success, true);
  assert.equal(data.name, "红色高跟鞋 - 周杰伦");
  assert.equal(calls.length, 1);
  const [cmd, args] = calls[0];
  assert.equal(cmd, "open");
  assert.match(args[0], /^orpheus:\/\//);
  assert.deepEqual(JSON.parse(Buffer.from(args[0].slice(10), "base64").toString()), {
    type: "song", id: "208902", cmd: "play", channel: "webset",
  });
  // 歌单不查歌曲详情
  const pl = await call("play_in_app", { type: "playlist", id: 18362383327 });
  assert.equal(pl.data.success, true);
  assert.equal(JSON.parse(Buffer.from(calls[1][1][0].slice(10), "base64").toString()).type, "playlist");
});

test("playback_control：macOS 发送媒体键；未授权时提示开启辅助功能", async () => {
  const ok = fakeRunner();
  const a = await connect({}, {}, { localControl: true, platform: "darwin", run: ok.run });
  const r = await a.call("playback_control", { action: "volume_up", times: 3 });
  assert.equal(r.data.success, true);
  assert.equal(ok.calls.length, 3);
  const [cmd, args] = ok.calls[0];
  assert.equal(cmd, "osascript");
  assert.deepEqual(args.slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.match(args[3], /\(0 << 16\)/); // NX_KEYTYPE_SOUND_UP = 0
  // 脚本本身是合法的 JavaScript
  assert.doesNotThrow(() => new Function(args[3] + "\nreturn run;"));

  const denied = fakeRunner("untrusted\n");
  const b = await connect({}, {}, { localControl: true, platform: "darwin", run: denied.run });
  const r2 = await b.call("playback_control", { action: "play_pause" });
  assert.equal(r2.res.isError, true);
  assert.match(r2.data, /辅助功能/);
});

test("playback_control：Windows 用 PowerShell 发虚拟键，Linux 用 playerctl", async () => {
  const win = fakeRunner();
  const w = await connect({}, {}, { localControl: true, platform: "win32", run: win.run });
  await w.call("playback_control", { action: "next" });
  assert.equal(win.calls[0][0], "powershell");
  assert.match(win.calls[0][1].at(-1), /keybd_event\(0xB0, 0, 1,/);
  await w.call("play_in_app", { type: "album", id: 1 });
  assert.deepEqual(win.calls[1].slice(0, 1), ["rundll32"]);

  const lin = fakeRunner();
  const l = await connect({}, {}, { localControl: true, platform: "linux", run: lin.run });
  await l.call("playback_control", { action: "previous" });
  assert.deepEqual(lin.calls[0], ["playerctl", ["previous"]]);
  const mute = await l.call("playback_control", { action: "mute" });
  assert.equal(mute.res.isError, true);
});

test("HTTP 模式：令牌鉴权 + Streamable HTTP", async () => {
  const fake = fakeNetease({
    "/weapi/v1/album/18915": () => ({ code: 200, album: { id: 18915, name: "叶惠美", artist: { name: "周杰伦" }, publishTime: 1059580800000, size: 11 }, songs: [SONG(186016, "晴天")] }),
  });
  const netease = new NeteaseClient({ fetch: fake.fetch, secretKey: () => KEY, jar: {} });
  const token = "test-token-0123456789abcdef";
  const http = startHttp(netease, { port: 0, host: "127.0.0.1", token });
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/mcp/wrong-token`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${base}/mcp`, { method: "POST", body: "{}" })).status, 401);

    // 1) 令牌放在路径中
    const c1 = new Client({ name: "t", version: "1" });
    await c1.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${token}`)));
    assert.equal((await c1.listTools()).tools.length, 22);
    assert.ok(!(await c1.listTools()).tools.some((t) => t.name === "playback_control"), "HTTP 模式默认不提供本机控制");
    const r = await c1.callTool({ name: "get_album", arguments: { id: 18915 } });
    const album = JSON.parse(r.content[0].text);
    assert.equal(album.album.publish_date, "2003-07-30");
    assert.equal(album.songs[0].name, "晴天");
    await c1.close();

    // 2) Bearer 头
    const c2 = new Client({ name: "t", version: "1" });
    await c2.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    assert.equal((await c2.listTools()).tools.length, 22);
    await c2.close();
  } finally {
    http.close();
  }
});
