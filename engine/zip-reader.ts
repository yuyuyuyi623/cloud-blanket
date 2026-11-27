/**
 * engine/zip-reader.ts —— ZIP 分段读取器（流式，不整包进内存）
 *
 * 背景：2026-11-22 真机实测，手机 JS 堆约 400MB 且开发包已占 ~100MB，
 * 280MB 导出包整包 bytes() 直接 OutOfMemoryError。
 * 做法：ZIP 格式的中央目录在文件尾部，先只读尾部（≤64KB+22B）拿到每个条目的
 * 位置与压缩方式，再按需读取单个条目的压缩字节并 inflate——内存峰值 ≈ 单条目大小。
 *
 * 依赖：fflate（纯 JS，RN 可用）只用于 inflate；ZIP 结构解析是手写的，
 * 因为 JSZip 在浏览器/RN 环境不支持"给一个 range reader"的用法。
 */

import { inflateSync } from 'fflate';

// ── 对外接口 ─────────────────────────────────────────────────

/**
 * 有界读取器：任何能"从指定位置读 N 字节"的东西都能充当
 * ——电脑上是 fs，手机上是 expo-file-system 的 readAsStringAsync(position, length)。
 */
export interface RangeReader {
  size: number;
  readRange(start: number, length: number): Promise<Uint8Array>;
}

export interface ZipEntryInfo {
  name: string;
  /** 0=store，8=deflate；其他值在 readEntry 时报错 */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

// ── ZIP 结构常量（little-endian） ────────────────────────────

const EOCD_SIG = 0x06054b50; // PK\x05\x06
const CD_SIG = 0x02014b50; // PK\x01\x02
const LFH_SIG = 0x04034b50; // PK\x03\x04

function u16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

/** 条目名是 ASCII（chat_sessions/xxx.json），latin1 逐字节转字符串即可 */
function latin1(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 8192) {
    out += String.fromCharCode(...b.subarray(i, i + 8192));
  }
  return out;
}

// ── 读取器 ───────────────────────────────────────────────────

export class ZipDirectory {
  private entries: ZipEntryInfo[] = [];
  private byName = new Map<string, ZipEntryInfo>();

  private constructor(readonly reader: RangeReader) {}

  /** 打开包：只读尾部 EOCD + 中央目录（几百 KB），不碰数据区 */
  static async open(reader: RangeReader): Promise<ZipDirectory> {
    if (reader.size < 22) throw new Error('不是合法的 ZIP：文件太小');

    // 1. 从尾部找 EOCD（注释最长 65535B，所以尾部 22+65535 必然覆盖）
    const tailLen = Math.min(reader.size, 22 + 65535);
    const tail = await reader.readRange(reader.size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (u32(tail, i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('不是合法的 ZIP：找不到目录结尾标记');

    const total = u16(tail, eocd + 10);
    const cdSize = u32(tail, eocd + 12);
    const cdOffset = u32(tail, eocd + 16);
    if (cdOffset + cdSize > reader.size) {
      throw new Error('不是合法的 ZIP：目录位置越界');
    }

    // 2. 读中央目录并解析条目（1206 个会话 ≈ 100~200KB，一次读完）
    const cd = await reader.readRange(cdOffset, cdSize);
    const z = new ZipDirectory(reader);
    let p = 0;
    for (let k = 0; k < total; k++) {
      if (cd.length - p < 46 || u32(cd, p) !== CD_SIG) break; // 坏目录条目就到此为止
      const method = u16(cd, p + 10);
      const flags = u16(cd, p + 8);
      const compressedSize = u32(cd, p + 20);
      const uncompressedSize = u32(cd, p + 24);
      const nameLen = u16(cd, p + 28);
      const extraLen = u16(cd, p + 30);
      const commentLen = u16(cd, p + 32);
      const localHeaderOffset = u32(cd, p + 42);
      const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
      // ZIP 规范：flags bit 11（0x800）= 文件名是 UTF-8（JSZip 对非 ASCII 名会设）
      const name = flags & 0x800 ? utf8Decode(nameBytes) : latin1(nameBytes);
      const info: ZipEntryInfo = { name, method, compressedSize, uncompressedSize, localHeaderOffset };
      z.entries.push(info);
      z.byName.set(name, info);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return z;
  }

  listNames(): string[] {
    return this.entries.map((e) => e.name);
  }

  /** 条目元信息（大小过滤用：附件动辄 MB 级，读之前先看 uncompressedSize） */
  info(name: string): ZipEntryInfo | undefined {
    return this.byName.get(name);
  }

  /** 按需读一个条目的完整内容（内存峰值 ≈ 该条目） */
  async readEntry(name: string): Promise<Uint8Array> {
    const e = this.byName.get(name);
    if (!e) throw new Error(`ZIP 里没有这个条目：${name}`);

    // 本地文件头 30B：nameLen@26、extraLen@28（可能与中央目录的 extra 不同长）
    const head = await this.reader.readRange(e.localHeaderOffset, 30);
    if (u32(head, 0) !== LFH_SIG) throw new Error(`ZIP 条目损坏（本地头不对）：${name}`);
    const nameLen = u16(head, 26);
    const extraLen = u16(head, 28);
    const dataStart = e.localHeaderOffset + 30 + nameLen + extraLen;

    const data = await this.reader.readRange(dataStart, e.compressedSize);
    if (e.method === 0) return data; // store
    if (e.method === 8) return inflateSync(data); // deflate（zip 用的是 raw deflate）
    throw new Error(`不支持的压缩方式（method=${e.method}）：${name}`);
  }
}

// ── 工具：base64 / UTF-8（手机端桥接用） ─────────────────────

const B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** expo legacy readAsStringAsync(Base64) 的返回值 → 字节 */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  let pad = 0;
  for (let i = clean.length - 1; i >= 0 && clean[i] === '='; i--) pad++;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4) - pad);
  let o = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64.indexOf(clean[i]!);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** UTF-8 字节 → 字符串。优先 TextDecoder，没有（老 Hermes）走手写解码 */
export function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(bytes);
  }
  return utf8DecodeManual(bytes);
}

function utf8DecodeManual(b: Uint8Array): string {
  let out = '';
  let buf: number[] = [];
  let i = 0;
  const flush = () => {
    if (buf.length) {
      out += String.fromCharCode(...buf);
      buf = [];
    }
  };
  while (i < b.length) {
    const c = b[i]!;
    let cp: number;
    let len: number;
    if (c < 0x80) {
      cp = c;
      len = 1;
    } else if (c < 0xe0 && i + 1 < b.length) {
      cp = ((c & 0x1f) << 6) | (b[i + 1]! & 0x3f);
      len = 2;
    } else if (c < 0xf0 && i + 2 < b.length) {
      cp = ((c & 0x0f) << 12) | ((b[i + 1]! & 0x3f) << 6) | (b[i + 2]! & 0x3f);
      len = 3;
    } else if (i + 3 < b.length) {
      cp =
        ((c & 0x07) << 18) |
        ((b[i + 1]! & 0x3f) << 12) |
        ((b[i + 2]! & 0x3f) << 6) |
        (b[i + 3]! & 0x3f);
      len = 4;
    } else {
      cp = 0xfffd;
      len = 1;
    }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      buf.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      buf.push(cp);
    }
    i += len;
    if (buf.length >= 8192) flush();
  }
  flush();
  return out;
}
