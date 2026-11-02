import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import { z } from "zod";
import { NeteaseClient, NeteaseError } from "./client.js";
import { parseCookieString } from "./cookies.js";
import * as F from "./format.js";
import { APP_RESOURCE_TYPES, MEDIA_ACTIONS, type Runner, defaultRunner, openUrl, orpheusPlayUrl, sendMediaKey } from "./local.js";

export const SERVER_NAME = "netease-music";
export const SERVER_VERSION = "0.2.0";

const BASE_INSTRUCTIONS = `网易云音乐 (music.163.com) 连接器。
- 歌曲、歌单、专辑、歌手都用数字 ID 标识。先用 search 找到 ID，再用 get_* 工具查看详情。
- 排行榜（飙升榜、热歌榜等）本质上是歌单：get_toplists 拿到榜单 ID 后用 get_playlist 查看曲目。
- 带 "我的"/需要登录的功能（每日推荐、我喜欢的音乐、我的歌单、听歌排行、收藏/建歌单）需要先登录：
  调用 login_qr_start 获得二维码，请用户用网易云音乐 App 扫码并确认，然后调用 login_qr_check。
- 返回结果里的 link 是网页链接，可以直接给用户点开播放。
- 修改类操作（like_song、create_playlist、update_playlist_tracks）会改动用户的真实账号，执行前先向用户确认。
- get_recent_plays 返回最近播放记录（所有设备，通常有几分钟延迟），可以回答“我刚才在听什么”。`;

const LOCAL_INSTRUCTIONS = `
- 本连接器运行在用户自己的电脑上，可以控制电脑上的网易云客户端：play_in_app 让客户端播放指定的歌曲 / 歌单 / 专辑 / 歌手，
  playback_control 发送系统媒体键（播放/暂停、上一首、下一首、音量）。媒体键作用于系统当前“正在播放”的应用。`;

const REMOTE_INSTRUCTIONS = `
- 当前是远程模式，无法控制用户设备上的播放；需要播放时把结果里的 link 给用户。`;

export interface ServerOptions {
  /** 是否提供 play_in_app / playback_control（只在连接器运行在用户自己电脑上时开启） */
  localControl?: boolean;
  /** 测试用 */
  platform?: NodeJS.Platform;
  /** 测试用 */
  run?: Runner;
}

function agoText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

const id = (what: string) => z.coerce.number().int().positive().describe(`${what} ID（数字）`);
const limit = (def: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(def).describe(`返回条数，默认 ${def}，最多 ${max}`);
const offset = z.coerce.number().int().min(0).default(0).describe("分页偏移量，默认 0");

const SEARCH_TYPES = {
  song: 1,
  album: 10,
  artist: 100,
  playlist: 1000,
  user: 1002,
  lyric: 1006,
  podcast: 1009,
} as const;

const COMMENT_PREFIX = {
  song: "R_SO_4_",
  playlist: "A_PL_0_",
  album: "R_AL_3_",
  mv: "R_MV_5_",
} as const;

const READ = { readOnlyHint: true, openWorldHint: true } as const;

function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

async function run(fn: () => Promise<unknown | CallToolResult>): Promise<CallToolResult> {
  try {
    const out = await fn();
    if (out && typeof out === "object" && "content" in (out as object)) return out as CallToolResult;
    return json(out);
  } catch (err) {
    const message = err instanceof NeteaseError || err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

async function songDetails(client: NeteaseClient, ids: number[]) {
  if (ids.length === 0) return [];
  const out: ReturnType<typeof F.songs> = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { body } = await client.request("/api/v3/song/detail", {
      c: JSON.stringify(chunk.map((x) => ({ id: x }))),
    });
    out.push(...F.songs(body.songs, body.privileges));
  }
  // 接口不保证按请求顺序返回，这里按传入的 ID 顺序重新排列
  const byId = new Map(out.map((s) => [s?.id, s]));
  return ids.map((x) => byId.get(x)).filter((s): s is NonNullable<typeof s> => Boolean(s));
}

async function resolveUid(client: NeteaseClient, uid?: number): Promise<number> {
  return uid ?? (await client.myUid());
}

export function createServer(client: NeteaseClient, opts: ServerOptions = {}): McpServer {
  const localControl = opts.localControl ?? false;
  const platform = opts.platform ?? process.platform;
  const runner = opts.run ?? defaultRunner;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: BASE_INSTRUCTIONS + (localControl ? LOCAL_INSTRUCTIONS : REMOTE_INSTRUCTIONS) },
  );

  // ------------------------------------------------------------------ 公开数据

  server.registerTool(
    "search",
    {
      title: "搜索",
      description: "在网易云音乐中搜索歌曲、专辑、歌手、歌单、用户、歌词或播客（电台）。",
      inputSchema: {
        keywords: z.string().min(1).describe("搜索关键词，例如 “晴天 周杰伦”"),
        type: z
          .enum(Object.keys(SEARCH_TYPES) as [keyof typeof SEARCH_TYPES, ...(keyof typeof SEARCH_TYPES)[]])
          .default("song")
          .describe("搜索类型：song 歌曲 / album 专辑 / artist 歌手 / playlist 歌单 / user 用户 / lyric 按歌词搜歌 / podcast 播客"),
        limit: limit(10, 50),
        offset,
      },
      annotations: { title: "搜索", ...READ },
    },
    ({ keywords, type, limit, offset }) =>
      run(async () => {
        const data = { s: keywords, type: SEARCH_TYPES[type], limit, offset, total: true };
        const hasResult = (b: any) => b?.result && typeof b.result === "object";
        // PC 客户端接口 (eapi) 优先：在境内 / 境外、登录 / 未登录状态下都返回明文结果；
        // 失败或结果为空结构时回退到网页版的 search/get。
        let body: any;
        try {
          ({ body } = await client.request("/api/cloudsearch/pc", data, { crypto: "eapi" }));
        } catch (err) {
          if (err instanceof NeteaseError && err.code === -1) throw err;
        }
        if (!hasResult(body)) ({ body } = await client.request("/api/search/get", data));
        const r = body.result ?? {};
        switch (type) {
          case "song":
            return { total: r.songCount, songs: F.songs(r.songs) };
          case "lyric":
            return {
              total: r.songCount,
              songs: (r.songs ?? []).map((s: any) => ({
                ...F.song(s),
                matched_lyric: Array.isArray(s.lyrics)
                  ? s.lyrics.slice(0, 4).join(" ")
                  : s.lyrics?.txt?.slice(0, 200),
              })),
            };
          case "album":
            return { total: r.albumCount, albums: (r.albums ?? []).map(F.album) };
          case "artist":
            return { total: r.artistCount, artists: (r.artists ?? []).map(F.artist) };
          case "playlist":
            return { total: r.playlistCount, playlists: (r.playlists ?? []).map(F.playlist) };
          case "user":
            return { total: r.userprofileCount, users: (r.userprofiles ?? []).map(F.user) };
          case "podcast":
            return { total: r.djRadiosCount, podcasts: (r.djRadios ?? []).map(F.podcast) };
        }
      }),
  );

  server.registerTool(
    "get_song_detail",
    {
      title: "歌曲详情",
      description: "根据歌曲 ID 批量获取歌曲信息（歌名、歌手、专辑、时长、是否 VIP）。",
      inputSchema: {
        ids: z.array(id("歌曲")).min(1).max(200).describe("歌曲 ID 列表，最多 200 个"),
      },
      annotations: { title: "歌曲详情", ...READ },
    },
    ({ ids }) => run(async () => ({ songs: await songDetails(client, ids) })),
  );

  server.registerTool(
    "get_lyrics",
    {
      title: "获取歌词",
      description: "获取歌曲歌词，包括原文、中文翻译和罗马音（如果有）。",
      inputSchema: {
        id: id("歌曲"),
        with_timestamps: z
          .boolean()
          .default(false)
          .describe("是否保留 LRC 时间轴 [mm:ss.xx]，默认 false 只返回纯文本"),
      },
      annotations: { title: "获取歌词", ...READ },
    },
    ({ id, with_timestamps }) =>
      run(async () => {
        const { body } = await client.request(
          "/api/song/lyric",
          { id, tv: -1, lv: -1, rv: -1, kv: -1 },
          { fallback: "eapi" },
        );
        if (body.nolyric || body.pureMusic) return { id, instrumental: true, message: "纯音乐，没有歌词" };
        if (body.uncollected) return { id, message: "暂时没有收录歌词" };
        const pick = (lrc?: string) => (with_timestamps ? lrc || undefined : F.stripLrc(lrc));
        return {
          id,
          lyric: pick(body.lrc?.lyric),
          translation: pick(body.tlyric?.lyric),
          romaji: pick(body.romalrc?.lyric),
          lyricist: body.lyricUser?.nickname,
        };
      }),
  );

  server.registerTool(
    "get_playlist",
    {
      title: "歌单详情",
      description: "获取歌单信息和其中的歌曲（支持分页）。排行榜也可以用这个工具查看。",
      inputSchema: {
        id: id("歌单"),
        limit: limit(50, 500),
        offset,
      },
      annotations: { title: "歌单详情", ...READ },
    },
    ({ id, limit, offset }) =>
      run(async () => {
        const { body } = await client.request("/api/v6/playlist/detail", { id, n: 100000, s: 8 }, { fallback: "eapi" });
        const pl = body.playlist;
        if (!pl) throw new NeteaseError("歌单不存在或无权查看", 404, body);
        const allIds: number[] = (pl.trackIds ?? []).map((t: any) => t.id);
        const pageIds = allIds.slice(offset, offset + limit);
        const tracks = pageIds.length ? await songDetails(client, pageIds) : F.songs(pl.tracks?.slice(offset, offset + limit));
        return {
          playlist: F.playlist(pl),
          total_tracks: allIds.length || pl.trackCount,
          offset,
          tracks,
          has_more: offset + limit < (allIds.length || pl.trackCount || 0),
        };
      }),
  );

  server.registerTool(
    "get_album",
    {
      title: "专辑详情",
      description: "获取专辑信息和曲目列表。",
      inputSchema: { id: id("专辑") },
      annotations: { title: "专辑详情", ...READ },
    },
    ({ id }) =>
      run(async () => {
        const { body } = await client.request(`/api/v1/album/${id}`);
        return { album: F.album(body.album), songs: F.songs(body.songs) };
      }),
  );

  server.registerTool(
    "get_artist",
    {
      title: "歌手详情",
      description: "获取歌手简介和热门歌曲，可选附带专辑列表。",
      inputSchema: {
        id: id("歌手"),
        top_songs: limit(20, 50).describe("返回的热门歌曲数量，默认 20，最多 50"),
        include_albums: z.boolean().default(false).describe("是否同时返回专辑列表"),
        album_limit: limit(20, 100).describe("专辑数量，默认 20"),
        album_offset: offset,
      },
      annotations: { title: "歌手详情", ...READ },
    },
    ({ id, top_songs, include_albums, album_limit, album_offset }) =>
      run(async () => {
        const { body } = await client.request(`/api/v1/artist/${id}`);
        const result: Record<string, unknown> = {
          artist: F.artist(body.artist),
          hot_songs: F.songs((body.hotSongs ?? []).slice(0, top_songs)),
        };
        if (include_albums) {
          const { body: ab } = await client.request(`/api/artist/albums/${id}`, {
            limit: album_limit,
            offset: album_offset,
            total: true,
          });
          result.albums = (ab.hotAlbums ?? []).map(F.album);
          result.has_more_albums = Boolean(ab.more);
        }
        return result;
      }),
  );

  server.registerTool(
    "get_toplists",
    {
      title: "排行榜列表",
      description: "获取网易云所有官方排行榜（飙升榜、新歌榜、热歌榜、原创榜等）。用 get_playlist 查看某个榜单的歌曲。",
      inputSchema: {},
      annotations: { title: "排行榜列表", ...READ },
    },
    () =>
      run(async () => {
        const { body } = await client.request("/api/toplist", {}, { fallback: "eapi" });
        return {
          toplists: (body.list ?? []).map((t: any) => ({
            id: t.id,
            name: t.name,
            update_frequency: t.updateFrequency,
            updated: F.date(t.updateTime),
            description: t.description ? String(t.description).slice(0, 120) : undefined,
          })),
        };
      }),
  );

  server.registerTool(
    "get_comments",
    {
      title: "评论",
      description: "获取歌曲 / 歌单 / 专辑 / MV 的评论。第一页会附带热门评论。",
      inputSchema: {
        id: id("资源"),
        resource_type: z.enum(["song", "playlist", "album", "mv"]).default("song").describe("资源类型，默认 song"),
        limit: limit(20, 100),
        offset,
      },
      annotations: { title: "评论", ...READ },
    },
    ({ id, resource_type, limit, offset }) =>
      run(async () => {
        const { body } = await client.request(`/api/v1/resource/comments/${COMMENT_PREFIX[resource_type]}${id}`, {
          rid: id,
          limit,
          offset,
          beforeTime: 0,
        });
        return {
          total: body.total,
          hot_comments: offset === 0 ? (body.hotComments ?? []).map(F.comment) : undefined,
          comments: (body.comments ?? []).map(F.comment),
          has_more: Boolean(body.more),
        };
      }),
  );

  server.registerTool(
    "get_similar_songs",
    {
      title: "相似歌曲",
      description: "根据一首歌获取网易云推荐的相似歌曲。",
      inputSchema: { id: id("歌曲"), limit: limit(20, 50) },
      annotations: { title: "相似歌曲", ...READ },
    },
    ({ id, limit }) =>
      run(async () => {
        const { body } = await client.request("/api/v1/discovery/simiSong", { songid: id, limit, offset: 0 });
        return { songs: F.songs(body.songs) };
      }),
  );

  // ------------------------------------------------------------------ 登录

  server.registerTool(
    "login_qr_start",
    {
      title: "扫码登录：生成二维码",
      description:
        "生成网易云音乐登录二维码。把二维码展示给用户（返回的图片，或把 qr_text 原样放进代码块），" +
        "请用户用网易云音乐 App 扫码并在手机上确认，然后调用 login_qr_check。",
      inputSchema: {},
      annotations: { title: "扫码登录：生成二维码", readOnlyHint: false, openWorldHint: true },
    },
    () =>
      run(async () => {
        // 网页版 (weapi, type=1) 优先；被风控拒绝时改用 PC 客户端 (eapi, type=3)
        let key: string;
        try {
          const { body } = await client.request("/api/login/qrcode/unikey", { type: 1, noCheckToken: true });
          key = `w:${body.unikey}`;
        } catch (err) {
          if (err instanceof NeteaseError && err.code === -1) throw err;
          const { body } = await client.request("/api/login/qrcode/unikey", { type: 3 }, { crypto: "eapi" });
          key = `e:${body.unikey}`;
        }
        const url = `https://music.163.com/login?codekey=${key.slice(2)}`;
        const png = await QRCode.toBuffer(url, { type: "png", width: 360, margin: 2 });
        const imagePath = join(tmpdir(), "netease-music-login-qr.png");
        try {
          writeFileSync(imagePath, png);
        } catch {
          /* 只读文件系统时忽略 */
        }
        const qrText = await QRCode.toString(url, { type: "utf8", margin: 2 });
        const info = {
          login_key: key,
          qr_url: url,
          qr_image_path: imagePath,
          qr_text: qrText,
          next_step: "请用户打开网易云音乐 App → 扫一扫，扫码后在手机上点“确认登录”，然后调用 login_qr_check（传入 login_key）。二维码约 5 分钟后过期。",
        };
        return {
          content: [
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
            { type: "text", text: JSON.stringify(info) },
          ],
        } satisfies CallToolResult;
      }),
  );

  server.registerTool(
    "login_qr_check",
    {
      title: "扫码登录：检查状态",
      description:
        "检查二维码登录状态。可设置 wait_seconds 在服务器端等待用户扫码（每 2 秒轮询一次），登录成功后自动保存登录状态。",
      inputSchema: {
        login_key: z.string().min(3).describe("login_qr_start 返回的 login_key"),
        wait_seconds: z.coerce.number().int().min(0).max(50).default(25).describe("最多等待多少秒，默认 25"),
      },
      annotations: { title: "扫码登录：检查状态", readOnlyHint: false, openWorldHint: true },
    },
    ({ login_key, wait_seconds }) =>
      run(async () => {
        const [mode, unikey] = login_key.startsWith("e:") || login_key.startsWith("w:")
          ? [login_key[0], login_key.slice(2)]
          : ["w", login_key];
        const deadline = Date.now() + wait_seconds * 1000;
        for (;;) {
          const { body, setCookies } = await client.request(
            "/api/login/qrcode/client/login",
            mode === "e" ? { key: unikey, type: 3 } : { key: unikey, type: 1, noCheckToken: true },
            { crypto: mode === "e" ? "eapi" : "weapi", okCodes: [800, 801, 802, 803, 8821] },
          );
          switch (body.code) {
            case 803: {
              const cookies = { ...setCookies };
              if (typeof body.cookie === "string") Object.assign(cookies, parseCookieString(body.cookie));
              if (!cookies.MUSIC_U) {
                throw new NeteaseError("扫码成功，但服务器没有返回登录 Cookie。请改用 NETEASE_COOKIE 方式登录（见 README）。", 803, body);
              }
              const file = client.setLoginCookie(cookies);
              let nickname: string | undefined;
              try {
                const { body: acc } = await client.request("/api/w/nuser/account/get");
                nickname = acc?.profile?.nickname;
              } catch {
                /* 忽略 */
              }
              return { status: "success", message: `登录成功${nickname ? `：${nickname}` : ""}`, saved_to: file };
            }
            case 800:
              return { status: "expired", message: "二维码已过期，请重新调用 login_qr_start。" };
            case 8821:
              return {
                status: "blocked",
                message: "网易云触发了风控验证，无法通过接口扫码登录。请改用 NETEASE_COOKIE 方式登录（见 README）。",
              };
          }
          if (Date.now() >= deadline) {
            return body.code === 802
              ? { status: "scanned", message: `已扫码${body.nickname ? `（${body.nickname}）` : ""}，等待用户在手机上确认。请稍后再次调用 login_qr_check。` }
              : { status: "waiting", message: "等待用户扫码。请稍后再次调用 login_qr_check。" };
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      }),
  );

  server.registerTool(
    "get_login_status",
    {
      title: "登录状态",
      description: "查看当前是否已登录网易云音乐，以及登录账号的基本信息。",
      inputSchema: {},
      annotations: { title: "登录状态", ...READ },
    },
    () =>
      run(async () => {
        if (!client.loggedIn) {
          return { logged_in: false, hint: "未登录。调用 login_qr_start 扫码登录，或在配置中设置 NETEASE_COOKIE。" };
        }
        const { body } = await client.request("/api/w/nuser/account/get");
        if (!body.profile) return { logged_in: false, hint: "登录已失效，请重新扫码登录。" };
        return {
          logged_in: true,
          cookie_source: client.cookieSource,
          ...F.user(body.profile),
          vip: Boolean(body.account?.vipType || body.profile?.vipType),
        };
      }),
  );

  server.registerTool(
    "logout",
    {
      title: "退出登录",
      description: "清除本连接器保存的网易云登录状态。",
      inputSchema: {},
      annotations: { title: "退出登录", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        const fromEnv = client.cookieSource === "env";
        client.logout();
        return {
          message: "已清除登录状态。",
          note: fromEnv ? "Cookie 来自 NETEASE_COOKIE 配置，重启后会重新生效；如需彻底退出请删除该配置。" : undefined,
        };
      }),
  );

  // ------------------------------------------------------------------ 个人数据（需登录）

  const uidParam = z.coerce.number().int().positive().optional().describe("用户 ID；不填则为当前登录用户");

  server.registerTool(
    "get_user_playlists",
    {
      title: "用户歌单",
      description: "获取用户创建和收藏的歌单（默认当前登录用户；他人的公开歌单也可以查）。",
      inputSchema: { uid: uidParam, limit: limit(30, 100), offset },
      annotations: { title: "用户歌单", ...READ },
    },
    ({ uid, limit, offset }) =>
      run(async () => {
        const userId = await resolveUid(client, uid);
        const { body } = await client.request("/api/user/playlist", { uid: userId, limit, offset, includeVideo: true });
        const lists = (body.playlist ?? []).map((p: any) => ({
          ...F.playlist(p),
          owned: p.creator?.userId === userId || p.userId === userId,
        }));
        return { uid: userId, playlists: lists, has_more: Boolean(body.more) };
      }),
  );

  server.registerTool(
    "get_liked_songs",
    {
      title: "我喜欢的音乐",
      description: "获取用户“喜欢”的歌曲（默认当前登录用户），和 App 里“我喜欢的音乐”歌单顺序一致：最近喜欢的在前，附带喜欢的日期。",
      inputSchema: { uid: uidParam, limit: limit(50, 500), offset },
      annotations: { title: "我喜欢的音乐", ...READ },
    },
    ({ uid, limit, offset }) =>
      run(async () => {
        const userId = await resolveUid(client, uid);
        // 优先读“我喜欢的音乐”歌单（specialType 5）：trackIds 按喜欢时间倒序，并带有喜欢时间 at。
        // /api/song/like/get 返回的 ID 没有固定顺序，只在读不到歌单时（例如他人的隐私歌单）作为后备。
        let ordered: { id: number; at?: number }[] | undefined;
        try {
          const { body: pl } = await client.request("/api/user/playlist", { uid: userId, limit: 30, offset: 0, includeVideo: true });
          const likedPl = (pl.playlist ?? []).find((p: any) => p.specialType === 5);
          if (likedPl) {
            const { body } = await client.request("/api/v6/playlist/detail", { id: likedPl.id, n: 100000, s: 8 }, { fallback: "eapi" });
            if (Array.isArray(body.playlist?.trackIds)) ordered = body.playlist.trackIds;
          }
        } catch (err) {
          if (err instanceof NeteaseError && (err.code === -1 || err.code === 301)) throw err;
        }
        if (!ordered) {
          const { body } = await client.request("/api/song/like/get", { uid: userId }, { fallback: "eapi" });
          ordered = (body.ids ?? []).map((x: number) => ({ id: x }));
        }
        const all = ordered ?? [];
        const page = all.slice(offset, offset + limit);
        const likedAt = new Map(page.map((t) => [t.id, F.date(t.at)]));
        const songs = (await songDetails(client, page.map((t) => t.id))).map((s) => ({ ...s, liked_at: likedAt.get(s.id as number) }));
        return {
          total: all.length,
          offset,
          order: all.some((t) => t.at) ? "最近喜欢的在前" : "顺序未知",
          songs,
          has_more: offset + limit < all.length,
        };
      }),
  );

  server.registerTool(
    "get_daily_recommendations",
    {
      title: "每日推荐",
      description: "获取当前登录用户的每日推荐歌曲（需要登录）。",
      inputSchema: {},
      annotations: { title: "每日推荐", ...READ },
    },
    () =>
      run(async () => {
        await client.myUid();
        const { body } = await client.request("/api/v3/discovery/recommend/songs", {});
        const reasons = new Map<number, string>(
          (body.data?.recommendReasons ?? []).map((r: any) => [r.songId, r.reason]),
        );
        return {
          songs: (body.data?.dailySongs ?? []).map((s: any) => ({
            ...F.song(s),
            reason: reasons.get(s.id) ?? s.reason ?? undefined,
          })),
        };
      }),
  );

  server.registerTool(
    "get_recommended_playlists",
    {
      title: "推荐歌单",
      description: "获取为当前登录用户推荐的歌单（需要登录）。",
      inputSchema: {},
      annotations: { title: "推荐歌单", ...READ },
    },
    () =>
      run(async () => {
        await client.myUid();
        const { body } = await client.request("/api/v1/discovery/recommend/resource", {});
        return { playlists: (body.recommend ?? []).map(F.playlist) };
      }),
  );

  server.registerTool(
    "get_listening_history",
    {
      title: "听歌排行",
      description: "获取用户的听歌排行（最近一周或所有时间）。他人的听歌排行可能因隐私设置不可见。",
      inputSchema: {
        uid: uidParam,
        period: z.enum(["week", "all"]).default("week").describe("week 最近一周 / all 所有时间"),
        limit: limit(30, 100),
      },
      annotations: { title: "听歌排行", ...READ },
    },
    ({ uid, period, limit }) =>
      run(async () => {
        const userId = await resolveUid(client, uid);
        const { body } = await client.request("/api/v1/play/record", { uid: userId, type: period === "week" ? 1 : 0 });
        const data: any[] = (period === "week" ? body.weekData : body.allData) ?? [];
        return {
          uid: userId,
          period,
          songs: data.slice(0, limit).map((r) => ({ ...F.song(r.song), play_count: r.playCount, score: r.score })),
        };
      }),
  );

  server.registerTool(
    "get_recent_plays",
    {
      title: "最近播放",
      description: "获取当前登录用户最近播放的歌曲（来自所有设备，按时间倒序，通常有几分钟延迟），可以回答“我刚才在听什么”。需要登录。",
      inputSchema: { limit: limit(10, 100) },
      annotations: { title: "最近播放", ...READ },
    },
    ({ limit }) =>
      run(async () => {
        await client.myUid();
        const { body } = await client.request("/api/play-record/song/list", { limit });
        const now = Date.now();
        const list: any[] = (body.data?.list ?? []).slice(0, limit);
        return {
          note: "播放记录通常比实际播放晚几分钟；第一首可能就是正在播放的歌。",
          songs: list.map((x) => ({ ...F.song(x.data), played_at: F.dateTime(x.playTime), ago: agoText(now - x.playTime) })),
        };
      }),
  );

  // ------------------------------------------------------------------ 本机播放控制（仅本地模式）

  if (localControl) {
    server.registerTool(
      "play_in_app",
      {
        title: "在网易云客户端播放",
        description:
          "让这台电脑上的网易云音乐客户端播放指定的歌曲、歌单、专辑、歌手热门歌曲或电台（客户端没打开时会先启动）。" +
          "ID 可以从 search、get_* 等工具获得。",
        inputSchema: {
          type: z.enum(APP_RESOURCE_TYPES).default("song").describe("song 歌曲 / playlist 歌单 / album 专辑 / artist 歌手 / djradio 电台"),
          id: id("要播放的资源"),
        },
        annotations: { title: "在网易云客户端播放", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      ({ type, id }) =>
        run(async () => {
          let name: string | undefined;
          if (type === "song") {
            try {
              const [s] = await songDetails(client, [id]);
              if (s) name = `${s.name} - ${s.artists}`;
            } catch {
              /* 只用于展示，忽略 */
            }
          }
          await openUrl(orpheusPlayUrl(type, id), platform, runner);
          return {
            success: true,
            type,
            id,
            name,
            note: "已让网易云客户端播放。如果客户端只打开了页面而没有开始播放，可以再调用 playback_control（play_pause）。",
          };
        }),
    );

    server.registerTool(
      "playback_control",
      {
        title: "播放控制",
        description:
          "控制这台电脑上的播放：播放/暂停、上一首、下一首、调节系统音量、静音。通过系统媒体键实现，作用于系统当前“正在播放”的应用" +
          "（正在用网易云听歌时就是网易云）。macOS 第一次使用需要在“系统设置 → 隐私与安全性 → 辅助功能”里允许 Claude。",
        inputSchema: {
          action: z
            .enum(MEDIA_ACTIONS)
            .describe("play_pause 播放/暂停 / next 下一首 / previous 上一首 / volume_up 音量+ / volume_down 音量- / mute 静音开关"),
          times: z.coerce.number().int().min(1).max(10).default(1).describe("重复次数，用于连续调节音量，默认 1"),
        },
        annotations: { title: "播放控制", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      ({ action, times }) =>
        run(async () => {
          for (let i = 0; i < times; i++) await sendMediaKey(action, platform, runner);
          return { success: true, action, times };
        }),
    );
  }

  // ------------------------------------------------------------------ 修改操作（需登录）

  server.registerTool(
    "like_song",
    {
      title: "喜欢 / 取消喜欢",
      description: "把歌曲加入（或移出）当前用户的“我喜欢的音乐”。会修改用户账号，调用前请确认。",
      inputSchema: {
        id: id("歌曲"),
        like: z.boolean().default(true).describe("true 喜欢，false 取消喜欢"),
      },
      annotations: { title: "喜欢 / 取消喜欢", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ id, like }) =>
      run(async () => {
        await client.myUid();
        await client.request("/api/radio/like", { alg: "itembased", trackId: id, like, time: "3" });
        return { success: true, id, liked: like };
      }),
  );

  server.registerTool(
    "create_playlist",
    {
      title: "新建歌单",
      description: "在当前用户账号下新建一个歌单，返回歌单 ID。之后可用 update_playlist_tracks 添加歌曲。会修改用户账号，调用前请确认。",
      inputSchema: {
        name: z.string().min(1).max(40).describe("歌单名称"),
        private: z.boolean().default(false).describe("是否设为隐私歌单，默认公开"),
      },
      annotations: { title: "新建歌单", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ name, private: isPrivate }) =>
      run(async () => {
        await client.myUid();
        const { body } = await client.request("/api/playlist/create", {
          name,
          privacy: isPrivate ? "10" : "0",
          type: "NORMAL",
        });
        const pid = body.id ?? body.playlist?.id;
        return { success: true, playlist: F.playlist({ ...body.playlist, id: pid, name }) };
      }),
  );

  server.registerTool(
    "update_playlist_tracks",
    {
      title: "歌单增删歌曲",
      description: "向当前用户自己创建的歌单添加或移除歌曲。会修改用户账号，调用前请确认。",
      inputSchema: {
        playlist_id: id("歌单"),
        song_ids: z.array(id("歌曲")).min(1).max(500).describe("歌曲 ID 列表"),
        op: z.enum(["add", "remove"]).default("add").describe("add 添加 / remove 移除"),
      },
      annotations: { title: "歌单增删歌曲", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ playlist_id, song_ids, op }) =>
      run(async () => {
        await client.myUid();
        const ids = song_ids.map(String);
        const send = (trackIds: string[], crypto: "weapi" | "eapi") =>
          client.request(
            "/api/playlist/manipulate/tracks",
            { op: op === "add" ? "add" : "del", pid: playlist_id, trackIds: JSON.stringify(trackIds), imme: "true" },
            { crypto },
          );
        const attempt = async (crypto: "weapi" | "eapi") => {
          try {
            await send(ids, crypto);
          } catch (err) {
            // 已知问题：部分情况下服务器返回 512，把 ID 重复一遍再提交即可成功
            if (err instanceof NeteaseError && err.code === 512) await send([...ids, ...ids], crypto);
            else throw err;
          }
        };
        try {
          await attempt("weapi");
        } catch (err) {
          if (!(err instanceof NeteaseError)) throw err;
          if (err.code === 502) throw new NeteaseError("操作失败：歌曲已在歌单中，或歌单不属于当前用户。", 502, err.body);
          if (err.code === -1 || err.code === 301 || err.code === 302) throw err;
          await attempt("eapi");
        }
        return { success: true, playlist_id, op, count: ids.length };
      }),
  );

  return server;
}
