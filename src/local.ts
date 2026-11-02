/**
 * 本机播放控制：只在连接器运行在用户自己的电脑上时有意义（stdio 模式）。
 *
 * - 打开 / 播放：使用网易云客户端注册的 orpheus:// 链接。格式与 music.163.com 网页版
 *   “在客户端播放”按钮一致：orpheus:// + Base64(JSON {type, id, cmd: "play", channel: "webset"})
 * - 播放控制：模拟系统媒体键（播放/暂停、上一首、下一首、音量），作用于系统当前的“正在播放”应用。
 */
import { execFile } from "node:child_process";

export type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout: String(stdout), stderr: String(stderr) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

export class LocalControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalControlError";
  }
}

export const APP_RESOURCE_TYPES = ["song", "playlist", "album", "artist", "djradio"] as const;
export type AppResourceType = (typeof APP_RESOURCE_TYPES)[number];

export function orpheusPlayUrl(type: AppResourceType, id: number | string): string {
  const payload = JSON.stringify({ type, id: String(id), cmd: "play", channel: "webset" });
  return "orpheus://" + Buffer.from(payload, "utf8").toString("base64");
}

export async function openUrl(url: string, platform: NodeJS.Platform = process.platform, run: Runner = defaultRunner) {
  try {
    if (platform === "darwin") await run("open", [url]);
    else if (platform === "win32") await run("rundll32", ["url.dll,FileProtocolHandler", url]);
    else await run("xdg-open", [url]);
  } catch (err) {
    throw new LocalControlError(
      `无法打开网易云音乐客户端：${errText(err)}。请确认电脑上安装了网易云音乐客户端（https://music.163.com/#/download）。`,
    );
  }
}

export const MEDIA_ACTIONS = ["play_pause", "next", "previous", "volume_up", "volume_down", "mute"] as const;
export type MediaAction = (typeof MEDIA_ACTIONS)[number];

// macOS: NX_KEYTYPE_* (IOKit/hidsystem/ev_keymap.h)
const MAC_KEY: Record<MediaAction, number> = { volume_up: 0, volume_down: 1, mute: 7, play_pause: 16, next: 17, previous: 18 };
// Windows: 虚拟键码
const WIN_VK: Record<MediaAction, number> = { volume_up: 0xaf, volume_down: 0xae, mute: 0xad, play_pause: 0xb3, next: 0xb0, previous: 0xb1 };
// Linux: playerctl（MPRIS）
const PLAYERCTL: Partial<Record<MediaAction, string[]>> = {
  play_pause: ["play-pause"],
  next: ["next"],
  previous: ["previous"],
  volume_up: ["volume", "0.1+"],
  volume_down: ["volume", "0.1-"],
};

/** macOS 上用 JXA 发送系统级媒体键事件。需要“辅助功能”权限，没有权限时会触发系统授权弹窗并输出 untrusted。 */
export function macMediaKeyScript(key: number): string {
  return [
    'ObjC.import("Cocoa");',
    'ObjC.import("ApplicationServices");',
    "function run() {",
    "  if (!$.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true }))) return 'untrusted';",
    "  [true, false].forEach(function (down) {",
    "    var ev = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(",
    `      14, { x: 0, y: 0 }, down ? 0xa00 : 0xb00, 0, 0, null, 8, (${key} << 16) | ((down ? 0xa : 0xb) << 8), -1);`,
    "    $.CGEventPost(0, ev.CGEvent);",
    "  });",
    "  return 'ok';",
    "}",
  ].join("\n");
}

export function winMediaKeyScript(vk: number): string {
  const hex = "0x" + vk.toString(16).toUpperCase();
  return [
    "$sig = '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);'",
    "$k = Add-Type -MemberDefinition $sig -Name NeteaseMcpKeys -Namespace NeteaseMcp -PassThru",
    `$k::keybd_event(${hex}, 0, 1, [UIntPtr]::Zero)`,
    `$k::keybd_event(${hex}, 0, 3, [UIntPtr]::Zero)`,
    "'ok'",
  ].join("; ");
}

export async function sendMediaKey(action: MediaAction, platform: NodeJS.Platform = process.platform, run: Runner = defaultRunner) {
  if (platform === "darwin") {
    let out: string;
    try {
      out = (await run("osascript", ["-l", "JavaScript", "-e", macMediaKeyScript(MAC_KEY[action])])).stdout.trim();
    } catch (err) {
      throw new LocalControlError(`发送媒体键失败：${errText(err)}`);
    }
    if (out === "untrusted") {
      throw new LocalControlError(
        "需要授权：请打开 Mac 的“系统设置 → 隐私与安全性 → 辅助功能”，打开 Claude 的开关（可能已经弹出了授权提示），然后再试一次。",
      );
    }
    return;
  }
  if (platform === "win32") {
    try {
      await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", winMediaKeyScript(WIN_VK[action])]);
    } catch (err) {
      throw new LocalControlError(`发送媒体键失败：${errText(err)}`);
    }
    return;
  }
  const args = PLAYERCTL[action];
  if (!args) throw new LocalControlError(`当前系统不支持“${action}”。`);
  try {
    await run("playerctl", args);
  } catch (err) {
    throw new LocalControlError(`控制失败：${errText(err)}。Linux 上需要安装 playerctl，并且播放器支持 MPRIS。`);
  }
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr || e?.message || String(err)).toString().trim().slice(0, 200);
}
