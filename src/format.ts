/** 把网易云的原始返回精简成对模型友好的结构，去掉无用字段以节省上下文。 */

type Any = any;

const WEB = "https://music.163.com/#";

function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

export function duration(ms: number | undefined): string | undefined {
  if (!ms || ms <= 0) return undefined;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function date(ms: number | undefined): string | undefined {
  if (!ms || ms <= 0) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}

/** 本地时间 YYYY-MM-DD HH:mm */
export function dateTime(ms: number | undefined): string | undefined {
  if (!ms || ms <= 0) return undefined;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** fee: 0 免费 / 1 VIP / 4 购买专辑 / 8 非会员可免费播放低音质 */
function feeLabel(fee: number | undefined): string | undefined {
  switch (fee) {
    case 1:
      return "VIP";
    case 4:
      return "付费专辑";
    default:
      return undefined;
  }
}

export function song(s: Any, privilege?: Any) {
  if (!s) return undefined;
  const artists: Any[] = s.ar ?? s.artists ?? [];
  const album = s.al ?? s.album ?? {};
  const aliases = [...(s.alia ?? s.alias ?? []), ...(s.tns ?? s.transNames ?? [])].filter(Boolean);
  const priv = privilege ?? s.privilege;
  return compact({
    id: s.id,
    name: s.name,
    artists: artists.map((a) => a.name).filter(Boolean).join(" / "),
    artist_ids: artists.map((a) => a.id).filter(Boolean),
    album: album.name,
    album_id: album.id || undefined,
    duration: duration(s.dt ?? s.duration),
    alias: aliases.length ? aliases.join(" / ") : undefined,
    fee: feeLabel(s.fee),
    unavailable: priv && typeof priv.st === "number" && priv.st < 0 ? true : undefined,
    link: `${WEB}/song?id=${s.id}`,
  });
}

export function songs(list: Any[] | undefined, privileges?: Any[]) {
  const privMap = new Map<number, Any>((privileges ?? []).map((p: Any) => [p.id, p]));
  return (list ?? []).map((s) => song(s, privMap.get(s?.id)));
}

export function playlist(p: Any) {
  if (!p) return undefined;
  return compact({
    id: p.id,
    name: p.name,
    creator: p.creator?.nickname,
    creator_id: p.creator?.userId ?? p.userId,
    track_count: p.trackCount,
    play_count: p.playCount ?? p.playcount,
    subscribed_count: p.subscribedCount ?? p.bookCount,
    tags: p.tags,
    description: p.description ? String(p.description).slice(0, 500) : undefined,
    reason: p.copywriter,
    privacy: p.privacy === 10 ? "私密" : undefined,
    special: p.specialType === 5 ? "我喜欢的音乐" : undefined,
    updated: date(p.trackUpdateTime ?? p.updateTime),
    cover: p.coverImgUrl ?? p.picUrl,
    link: `${WEB}/playlist?id=${p.id}`,
  });
}

export function album(a: Any) {
  if (!a) return undefined;
  const artists: Any[] = a.artists?.length ? a.artists : a.artist ? [a.artist] : [];
  return compact({
    id: a.id,
    name: a.name,
    artists: artists.map((x) => x.name).filter(Boolean).join(" / "),
    publish_date: date(a.publishTime),
    size: a.size,
    company: a.company,
    type: a.subType ?? a.type,
    description: a.description ? String(a.description).slice(0, 800) : undefined,
    cover: a.picUrl ?? a.blurPicUrl,
    link: `${WEB}/album?id=${a.id}`,
  });
}

export function artist(a: Any) {
  if (!a) return undefined;
  const aliases = [...(a.alias ?? []), ...(a.trans ? [a.trans] : [])].filter(Boolean);
  return compact({
    id: a.id,
    name: a.name,
    alias: aliases.length ? aliases.join(" / ") : undefined,
    album_count: a.albumSize,
    song_count: a.musicSize,
    mv_count: a.mvSize,
    brief: a.briefDesc ? String(a.briefDesc).slice(0, 800) : undefined,
    avatar: a.img1v1Url ?? a.picUrl,
    link: `${WEB}/artist?id=${a.id}`,
  });
}

export function user(u: Any) {
  if (!u) return undefined;
  return compact({
    user_id: u.userId,
    nickname: u.nickname,
    signature: u.signature,
    followers: u.followeds,
    playlist_count: u.playlistCount,
    vip: u.vipType ? true : undefined,
    link: `${WEB}/user/home?id=${u.userId}`,
  });
}

export function podcast(r: Any) {
  if (!r) return undefined;
  return compact({
    id: r.id,
    name: r.name,
    host: r.dj?.nickname,
    category: r.category,
    program_count: r.programCount,
    subscribed_count: r.subCount,
    description: r.desc ? String(r.desc).slice(0, 300) : undefined,
    link: `${WEB}/djradio?id=${r.id}`,
  });
}

export function comment(c: Any) {
  return compact({
    user: c.user?.nickname,
    content: c.content,
    liked: c.likedCount,
    time: c.timeStr ?? date(c.time),
    location: c.ipLocation?.location,
    reply_to: c.beReplied?.[0]?.content,
  });
}

/** 去掉 LRC 时间轴，只保留歌词文本。 */
export function stripLrc(lrc: string | undefined): string | undefined {
  if (!lrc) return undefined;
  const lines = lrc
    .split(/\r?\n/)
    .map((line) => line.replace(/\[[^\]]*\]/g, "").trim())
    .filter((line) => line && !/^\{.*\}$/.test(line)); // 新版歌词开头的 JSON 元数据行
  return lines.join("\n") || undefined;
}
