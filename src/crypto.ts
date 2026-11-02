/**
 * 网易云音乐 Web / PC 客户端接口使用的请求加密。
 *
 * - weapi：网页版 (music.163.com/weapi/...)，两次 AES-128-CBC + RSA(无填充) 加密随机密钥
 * - eapi ：PC 客户端 (interfacepc.music.163.com/eapi/...)，AES-128-ECB + MD5 摘要
 *
 * 只用 Node 自带的 crypto，不依赖第三方库。
 */
import { createCipheriv, createDecipheriv, createHash, randomInt } from "node:crypto";

const IV = "0102030405060708";
const PRESET_KEY = "0CoJUm6Qyw8W8jud";
const EAPI_KEY = "e82ckenh8dichen8";
const BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// 网易云 Web 端 RSA 公钥（1024 位，e = 65537）
const RSA_MODULUS = BigInt(
  "0x00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7",
);
const RSA_EXPONENT = 65537n;

function aesCbcBase64(text: string, key: string): string {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key, "utf8"), Buffer.from(IV, "utf8"));
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
}

function aesEcbHexUpper(text: string, key: string): string {
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(key, "utf8"), null);
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("hex").toUpperCase();
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

/** 教科书式 RSA（无填充），与网易云前端 / node-forge 'NONE' 模式结果一致。 */
function rsaNoPadding(text: string): string {
  const m = BigInt("0x" + Buffer.from(text, "utf8").toString("hex"));
  return modPow(m, RSA_EXPONENT, RSA_MODULUS).toString(16).padStart(256, "0");
}

export function randomSecretKey(): string {
  let key = "";
  for (let i = 0; i < 16; i++) key += BASE62.charAt(randomInt(62));
  return key;
}

export function weapi(
  data: Record<string, unknown>,
  secretKey: string = randomSecretKey(),
): { params: string; encSecKey: string } {
  const text = JSON.stringify(data);
  return {
    params: aesCbcBase64(aesCbcBase64(text, PRESET_KEY), secretKey),
    encSecKey: rsaNoPadding(secretKey.split("").reverse().join("")),
  };
}

export function eapi(uri: string, data: Record<string, unknown> | string): { params: string } {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  const digest = createHash("md5").update(`nobody${uri}use${text}md5forencrypt`).digest("hex");
  return { params: aesEcbHexUpper(`${uri}-36cd479b6b5-${text}-36cd479b6b5-${digest}`, EAPI_KEY) };
}

// ---- 以下解密函数只用于测试 / 调试 ----

export function weapiDecrypt(params: string, secretKey: string): unknown {
  const dec = (b64: string, key: string) => {
    const d = createDecipheriv("aes-128-cbc", Buffer.from(key, "utf8"), Buffer.from(IV, "utf8"));
    return Buffer.concat([d.update(Buffer.from(b64, "base64")), d.final()]).toString("utf8");
  };
  return JSON.parse(dec(dec(params, secretKey), PRESET_KEY));
}

export function eapiDecrypt(params: string): { uri: string; data: Record<string, unknown> } {
  const d = createDecipheriv("aes-128-ecb", Buffer.from(EAPI_KEY, "utf8"), null);
  const plain = Buffer.concat([d.update(Buffer.from(params, "hex")), d.final()]).toString("utf8");
  const m = plain.match(/^(.*?)-36cd479b6b5-(.*)-36cd479b6b5-([0-9a-f]{32})$/s);
  if (!m) throw new Error("eapi payload 格式不正确");
  return { uri: m[1], data: JSON.parse(m[2]) };
}
