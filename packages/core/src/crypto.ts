/**
 * AES-256-GCM envelope.
 *
 *   "AMX1" | u16 headerLen | header JSON | 12-byte IV | ciphertext || 16-byte tag
 *
 * The header stays in clear so expiry can be enforced (and expired files
 * deleted) without the key, but it is fed to GCM as additional authenticated
 * data, so any tampering with it - e.g. extending `createdAt` to dodge the TTL -
 * makes decryption fail.
 */
import { concat, fromUtf8, toBufferSource, utf8 } from "./bytes.ts";

const MAGIC = utf8("AMX1");
const IV_BYTES = 12;

export interface EnvelopeHeader {
  readonly v: 1;
  /** ms since epoch, authenticated. */
  readonly createdAt: number;
  /** Payload was gzip-compressed before encryption. */
  readonly gz: boolean;
  /** Purpose tag; binds a ciphertext to its use so a secret can't be swapped in as a snapshot. */
  readonly kind: "snapshot" | "secret";
}

export class EnvelopeError extends Error {
  override readonly name = "EnvelopeError";
}

export async function seal(key: CryptoKey, header: EnvelopeHeader, plaintext: Uint8Array): Promise<Uint8Array> {
  const headerBytes = utf8(JSON.stringify(header));
  if (headerBytes.byteLength > 0xffff) throw new EnvelopeError("header too large");
  const prefix = new Uint8Array(MAGIC.byteLength + 2 + headerBytes.byteLength);
  prefix.set(MAGIC, 0);
  new DataView(prefix.buffer).setUint16(MAGIC.byteLength, headerBytes.byteLength);
  prefix.set(headerBytes, MAGIC.byteLength + 2);

  // A fresh random 96-bit IV per message. With one key per device and far fewer
  // than 2^32 writes, random IVs stay well inside GCM's collision bound.
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: prefix, tagLength: 128 },
    key,
    toBufferSource(plaintext),
  );
  return concat([prefix, iv, new Uint8Array(ciphertext)]);
}

/** Parse the clear header only. Never trust it until `open` succeeds. */
export function peekHeader(envelope: Uint8Array): EnvelopeHeader {
  if (envelope.byteLength < MAGIC.byteLength + 2) throw new EnvelopeError("truncated envelope");
  for (let i = 0; i < MAGIC.byteLength; i++) {
    if (envelope[i] !== MAGIC[i]) throw new EnvelopeError("not an AETHER Mux envelope");
  }
  const len = new DataView(envelope.buffer, envelope.byteOffset).getUint16(MAGIC.byteLength);
  const start = MAGIC.byteLength + 2;
  if (envelope.byteLength < start + len + IV_BYTES + 16) throw new EnvelopeError("truncated envelope");
  let header: unknown;
  try {
    header = JSON.parse(fromUtf8(envelope.subarray(start, start + len)));
  } catch {
    throw new EnvelopeError("corrupt envelope header");
  }
  const h = header as Partial<EnvelopeHeader>;
  if (h.v !== 1 || typeof h.createdAt !== "number" || typeof h.gz !== "boolean" || (h.kind !== "snapshot" && h.kind !== "secret")) {
    throw new EnvelopeError("unsupported envelope header");
  }
  return h as EnvelopeHeader;
}

export async function open(
  key: CryptoKey,
  envelope: Uint8Array,
  expectedKind: EnvelopeHeader["kind"],
): Promise<{ header: EnvelopeHeader; plaintext: Uint8Array }> {
  const header = peekHeader(envelope);
  if (header.kind !== expectedKind) throw new EnvelopeError(`expected ${expectedKind} envelope, got ${header.kind}`);
  const len = new DataView(envelope.buffer, envelope.byteOffset).getUint16(MAGIC.byteLength);
  const prefixEnd = MAGIC.byteLength + 2 + len;
  const prefix = envelope.slice(0, prefixEnd);
  const iv = envelope.slice(prefixEnd, prefixEnd + IV_BYTES);
  const body = envelope.slice(prefixEnd + IV_BYTES);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: prefix, tagLength: 128 }, key, body);
    return { header, plaintext: new Uint8Array(plaintext) };
  } catch {
    // Wrong key (e.g. data wiped / different device) and tampering are indistinguishable by design.
    throw new EnvelopeError("decryption failed: wrong key or tampered data");
  }
}
