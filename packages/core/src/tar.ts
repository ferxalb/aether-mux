/**
 * Minimal POSIX ustar codec with pax extended headers.
 *
 * Tar is the portable workspace format: BrowserPod produces it natively with
 * `tar`, and Nodepod's virtual FS is walked into it here. Reading accepts what
 * GNU tar and busybox emit (pax `x`/`g`, GNU `L`/`K` long names).
 */
import { concat, fromUtf8, utf8 } from "./bytes.ts";

export type TarEntryKind = "file" | "directory" | "symlink";

export interface TarEntry {
  /** Relative POSIX path without a leading "./" or "/", directories without trailing "/". */
  readonly path: string;
  readonly kind: TarEntryKind;
  readonly mode?: number;
  /** Seconds since epoch. */
  readonly mtime?: number;
  readonly data?: Uint8Array;
  readonly linkTarget?: string;
}

const BLOCK = 512;
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

function normalisePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    // Reject traversal outright rather than resolving it: an archive that climbs
    // out of the workspace is either corrupt or hostile.
    if (part === "..") throw new Error(`tar: refusing path with "..": ${path}`);
    parts.push(part);
  }
  return parts.join("/");
}

function writeString(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = utf8(value);
  header.set(bytes.subarray(0, length), offset);
}

function writeOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  // length-1 octal digits followed by NUL.
  const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0");
  writeString(header, offset, length - 1, text);
  header[offset + length - 1] = 0;
}

function paxRecord(key: string, value: string): Uint8Array {
  // Record length includes its own decimal digits, so iterate to a fixed point.
  const body = ` ${key}=${value}\n`;
  const bodyLen = utf8(body).byteLength;
  let len = bodyLen + 1;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return utf8(`${len}${body}`);
}

function padToBlock(bytes: Uint8Array): Uint8Array[] {
  const rem = bytes.byteLength % BLOCK;
  return rem === 0 ? [bytes] : [bytes, new Uint8Array(BLOCK - rem)];
}

function headerBlock(
  name: string,
  typeflag: string,
  size: number,
  mode: number,
  mtime: number,
  linkname = "",
): Uint8Array {
  const h = new Uint8Array(BLOCK);
  writeString(h, 0, 100, name);
  writeOctal(h, 100, 8, mode);
  writeOctal(h, 108, 8, 0); // uid
  writeOctal(h, 116, 8, 0); // gid
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, mtime);
  h.fill(0x20, 148, 156); // checksum placeholder: spaces
  writeString(h, 156, 1, typeflag);
  writeString(h, 157, 100, linkname);
  writeString(h, 257, 6, "ustar");
  writeString(h, 263, 2, "00");
  let sum = 0;
  for (const b of h) sum += b;
  writeOctal(h, 148, 7, sum);
  h[155] = 0x20;
  return h;
}

function fitsUstar(value: string): boolean {
  return utf8(value).byteLength <= 100 && /^[\x20-\x7e]*$/.test(value);
}

export function packTar(entries: Iterable<TarEntry>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const path = normalisePath(entry.path);
    if (!path) continue;
    const name = entry.kind === "directory" ? `${path}/` : path;
    const data = entry.kind === "file" ? (entry.data ?? new Uint8Array()) : new Uint8Array();
    const mode = entry.mode ?? (entry.kind === "directory" ? 0o755 : 0o644);
    const mtime = entry.mtime ?? Math.floor(Date.now() / 1000);
    const link = entry.linkTarget ?? "";

    const needsPax = !fitsUstar(name) || !fitsUstar(link);
    if (needsPax) {
      const records = [paxRecord("path", name)];
      if (link) records.push(paxRecord("linkpath", link));
      const pax = concat(records);
      chunks.push(headerBlock("././@PaxHeader", "x", pax.byteLength, 0o644, mtime), ...padToBlock(pax));
    }
    const shortName = needsPax ? name.slice(0, 99) : name;
    const shortLink = needsPax ? link.slice(0, 99) : link;
    const flag = entry.kind === "directory" ? "5" : entry.kind === "symlink" ? "2" : "0";
    chunks.push(headerBlock(shortName, flag, data.byteLength, mode & 0o7777, mtime, shortLink));
    if (data.byteLength) chunks.push(...padToBlock(data));
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  return concat(chunks);
}

function readString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return fromUtf8(nul === -1 ? slice : slice.subarray(0, nul));
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const first = block[offset] ?? 0;
  if (first & 0x80) {
    // GNU base-256 encoding for values that overflow octal.
    let value = first & 0x7f;
    for (let i = 1; i < length; i++) value = value * 256 + (block[offset + i] ?? 0);
    return value;
  }
  const text = readString(block, offset, length).trim();
  return text ? parseInt(text, 8) : 0;
}

function parsePax(bytes: Uint8Array): Map<string, string> {
  // Each record is "<byte length> <key>=<value>\n"; the length is in bytes, so walk bytes.
  const out = new Map<string, string>();
  let i = 0;
  while (i < bytes.byteLength) {
    const space = bytes.indexOf(0x20, i);
    if (space === -1) break;
    const len = parseInt(fromUtf8(bytes.subarray(i, space)), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > bytes.byteLength) break;
    const record = fromUtf8(bytes.subarray(space + 1, i + len - 1)); // drop trailing "\n"
    const eq = record.indexOf("=");
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    i += len;
  }
  return out;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const b of block) if (b !== 0) return false;
  return true;
}

export function unpackTar(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pending: Map<string, string> | null = null;
  let longName: string | null = null;
  let longLink: string | null = null;

  while (offset + BLOCK <= archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (isZeroBlock(header)) break;

    const size = readOctal(header, 124, 12);
    if (size > MAX_ENTRY_BYTES || offset + size > archive.byteLength) throw new Error("tar: truncated or oversized entry");
    const body = archive.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    const flag = String.fromCharCode(header[156] ?? 0);
    if (flag === "x") {
      pending = parsePax(body);
      continue;
    }
    if (flag === "g") continue;
    if (flag === "L") {
      longName = readString(body, 0, body.byteLength);
      continue;
    }
    if (flag === "K") {
      longLink = readString(body, 0, body.byteLength);
      continue;
    }

    const prefix = readString(header, 345, 155);
    let name = readString(header, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    name = pending?.get("path") ?? longName ?? name;
    const link = pending?.get("linkpath") ?? longLink ?? readString(header, 157, 100);
    pending = null;
    longName = null;
    longLink = null;

    const path = normalisePath(name);
    if (!path) continue;
    const mode = readOctal(header, 100, 8);
    const mtime = readOctal(header, 136, 12);

    if (flag === "5") entries.push({ path, kind: "directory", mode, mtime });
    else if (flag === "2") entries.push({ path, kind: "symlink", mode, mtime, linkTarget: link });
    else if (flag === "0" || flag === "\0" || flag === "7") {
      entries.push({ path, kind: "file", mode, mtime, data: body.slice() });
    }
    // Hard links, devices and FIFOs are intentionally skipped: none are meaningful in a browser guest.
  }
  return entries;
}
