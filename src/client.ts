/**
 * 网易云音乐 HTTP 客户端。
 *
 * 默认使用网页版的 weapi 接口（music.163.com 网页播放器本身调用的就是这些接口，
 * 未登录也能访问公开数据）；少数接口在 weapi 失败时回退到 PC 客户端的 eapi。
 */
import { randomBytes } from "node:crypto";
import { eapi, randomSecretKey, weapi } from "./crypto.js";
import {
  type CookieJar,
  deleteSavedCookie,
  loadInitialCookie,
  parseSetCookie,
  saveCookie,
} from "./cookies.js";

const WEB_DOMAIN = "https://music.163.com";
const EAPI_DOMAIN = "https://interfacepc.music.163.com";
const WEB_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
const EAPI_UA = "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)";
const PC_CLIENT = {
  os: "pc",
  appver: "3.1.17.204416",
  osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
  channel: "netease",
};

export type Crypto = "weapi" | "eapi";

/** 境外网络返回加密数据时使用的错误码（本连接器自定义） */
export const ABROAD_CODE = -2;

export interface RequestOptions {
  crypto?: Crypto;
  /** 除 200 之外，这些 code 也视为正常返回（例如扫码登录的 800-803） */
  okCodes?: number[];
}

export interface NeteaseResponse<T = any> {
  body: T;
  setCookies: CookieJar;
}

export class NeteaseError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "NeteaseError";
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export class NeteaseClient {
  jar: CookieJar;
  cookieSource: "env" | "file" | "qr" | "none";
  private readonly device: CookieJar;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly secretKey: () => string;

  constructor(
    opts: { fetch?: FetchLike; jar?: CookieJar; timeoutMs?: number; /** 仅测试用 */ secretKey?: () => string } = {},
  ) {
    if (opts.jar) {
      this.jar = { ...opts.jar };
      this.cookieSource = Object.keys(opts.jar).length ? "env" : "none";
    } else {
      const initial = loadInitialCookie();
      this.jar = initial.jar;
      this.cookieSource = initial.source;
    }
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.secretKey = opts.secretKey ?? randomSecretKey;
    const nuid = randomHex(16);
    // 模拟一个稳定的“设备”，整个进程生命周期内不变
    this.device = {
      _ntes_nuid: nuid,
      _ntes_nnid: `${nuid},${Date.now()}`,
      NMTID: "00O" + randomHex(19),
      WNMCID: `${randomHex(3)}.${Date.now()}.01.0`,
      WEVNSM: "1.0.0",
      deviceId: randomHex(16).toUpperCase(),
      ...PC_CLIENT,
    };
  }

  get loggedIn(): boolean {
    return Boolean(this.jar.MUSIC_U);
  }

  /** 登录成功后保存 cookie（内存 + 本地文件），返回文件路径。 */
  setLoginCookie(cookies: CookieJar): string {
    this.jar = { ...this.jar, ...cookies };
    this.cookieSource = "qr";
    return saveCookie(this.jar);
  }

  logout(): void {
    this.jar = {};
    this.cookieSource = "none";
    deleteSavedCookie();
  }

  /**
   * 调用接口。`fallback` 指定另一种加密方式：第一次请求被服务器以业务错误拒绝时
   * （非网络错误、非“需要登录”），自动换用它再试一次。
   */
  async request<T = any>(
    uri: string,
    data: Record<string, unknown> = {},
    opts: RequestOptions & { fallback?: Crypto } = {},
  ): Promise<NeteaseResponse<T>> {
    try {
      return await this.requestOnce<T>(uri, data, opts);
    } catch (err) {
      const retryable = err instanceof NeteaseError && err.code !== -1 && err.code !== 301 && err.code !== 302;
      if (!opts.fallback || opts.fallback === (opts.crypto ?? "weapi") || !retryable) throw err;
      return await this.requestOnce<T>(uri, data, { ...opts, crypto: opts.fallback });
    }
  }

  private async requestOnce<T>(uri: string, data: Record<string, unknown>, opts: RequestOptions): Promise<NeteaseResponse<T>> {
    if (!uri.startsWith("/api/")) throw new Error(`uri 必须以 /api/ 开头: ${uri}`);
    const crypto = opts.crypto ?? "weapi";
    const csrf = this.jar.__csrf ?? "";
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "*/*",
    };
    let url: string;
    let form: Record<string, string>;

    if (crypto === "weapi") {
      const cookie = { ...this.device, ...this.jar };
      headers.Cookie = Object.entries(cookie)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
      headers.Referer = WEB_DOMAIN;
      headers.Origin = WEB_DOMAIN;
      headers["User-Agent"] = WEB_UA;
      url = `${WEB_DOMAIN}/weapi/${uri.slice(5)}?csrf_token=${encodeURIComponent(csrf)}`;
      form = weapi({ ...data, csrf_token: csrf }, this.secretKey());
    } else {
      const header: Record<string, string> = {
        osver: PC_CLIENT.osver,
        deviceId: this.device.deviceId,
        os: PC_CLIENT.os,
        appver: PC_CLIENT.appver,
        versioncode: "140",
        mobilename: "",
        buildver: String(Math.floor(Date.now() / 1000)),
        resolution: "1920x1080",
        __csrf: csrf,
        channel: PC_CLIENT.channel,
        requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
      };
      if (this.jar.MUSIC_U) header.MUSIC_U = this.jar.MUSIC_U;
      if (this.jar.MUSIC_A) header.MUSIC_A = this.jar.MUSIC_A;
      header.NMTID = this.jar.NMTID ?? this.device.NMTID;
      headers.Cookie = Object.entries(header)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("; ");
      headers["User-Agent"] = EAPI_UA;
      url = `${EAPI_DOMAIN}/eapi/${uri.slice(5)}`;
      form = eapi(uri, { ...data, header, e_r: false });
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new NeteaseError(`无法连接网易云音乐服务器 (${new URL(url).host})：${reason}`, -1);
    }

    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new NeteaseError(`网易云返回了无法解析的内容 (HTTP ${res.status})：${text.slice(0, 200)}`, res.status);
    }

    const setCookieHeaders =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : (res.headers.get("set-cookie")?.split(/,(?=\s*[A-Za-z0-9_]+=)/) ?? []);
    const setCookies = parseSetCookie(setCookieHeaders);

    // 网易云把请求识别为境外网络时，部分接口会返回 { abroad: true, result: "<加密字符串>" }。
    // 视为可恢复的错误，让调用方回退到其它接口。
    if (body?.abroad === true && typeof body?.result === "string") {
      throw new NeteaseError(
        "网易云把当前网络识别为境外，返回了加密数据。请在中国大陆网络环境下使用，或稍后重试。",
        ABROAD_CODE,
        body,
      );
    }

    const code = Number(body?.code ?? res.status);
    if (code === 200 || opts.okCodes?.includes(code)) return { body, setCookies };
    if (code === 301 || code === 302) {
      throw new NeteaseError("需要登录网易云音乐。请先调用 login_qr_start 扫码登录，或设置 NETEASE_COOKIE。", code, body);
    }
    const msg = body?.message || body?.msg || body?.data?.blockText || `HTTP ${res.status}`;
    throw new NeteaseError(`网易云接口返回错误 (code ${code})：${msg}`, code, body);
  }

  /** 当前登录用户的 uid；未登录时抛错。 */
  async myUid(): Promise<number> {
    if (!this.loggedIn) {
      throw new NeteaseError("需要登录网易云音乐。请先调用 login_qr_start 扫码登录，或设置 NETEASE_COOKIE。", 301);
    }
    const { body } = await this.request("/api/w/nuser/account/get");
    const uid = body?.account?.id ?? body?.profile?.userId;
    if (!uid) throw new NeteaseError("登录已失效，请重新扫码登录（login_qr_start）。", 301, body);
    return Number(uid);
  }
}
