import { compressionSupported, concat, fromUtf8, gunzip, gzip, randomId, utf8 } from "./bytes.ts";
import { open, peekHeader, seal } from "./crypto.ts";
import type { KeyProvider } from "./keys.ts";
import type { BlobStore } from "./opfs.ts";
import { isProfileId, type ProfileId } from "./types.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const SNAPSHOT_TTL_MS = 30 * DAY_MS;
/** Tolerated clock skew before a "future" timestamp is treated as tampering. */
const FUTURE_SKEW_MS = DAY_MS;
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;

export interface SnapshotSummary {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly sizeBytes: number;
}

export interface SnapshotMeta {
  readonly profile: ProfileId;
  readonly workdir: string;
  readonly label: string;
}

export interface Snapshot extends SnapshotSummary {
  readonly meta: SnapshotMeta;
  /** ustar archive of the workspace. */
  readonly tar: Uint8Array;
}

export class SnapshotUnavailableError extends Error {
  override readonly name = "SnapshotUnavailableError";
}

export interface SnapshotStoreOptions {
  readonly blobs: BlobStore;
  readonly keys: KeyProvider;
  readonly ttlMs?: number;
  /** Oldest snapshots beyond this count are deleted on save. */
  readonly maxSnapshots?: number;
  readonly now?: () => number;
}

// createdAt is zero-padded so lexical order == chronological order.
const NAME = /^s-(\d{15})-([0-9a-f]{16})\.amx$/;

function fileName(createdAt: number, rand: string): string {
  return `s-${String(createdAt).padStart(15, "0")}-${rand}.amx`;
}

function parseName(name: string): { id: string; createdAt: number } | null {
  const m = NAME.exec(name);
  return m ? { id: name, createdAt: Number(m[1]) } : null;
}

/**
 * Encrypted, expiring workspace snapshots.
 *
 * TTL is enforced twice: by `purgeExpired()` from the (cheap, unauthenticated)
 * filename timestamp, and again on `load()` from the authenticated envelope
 * header, so renaming a file cannot resurrect an expired snapshot.
 */
export class SnapshotStore {
  readonly ttlMs: number;
  readonly #blobs: BlobStore;
  readonly #keys: KeyProvider;
  readonly #max: number;
  readonly #now: () => number;

  constructor(opts: SnapshotStoreOptions) {
    this.#blobs = opts.blobs;
    this.#keys = opts.keys;
    this.ttlMs = opts.ttlMs ?? SNAPSHOT_TTL_MS;
    this.#max = opts.maxSnapshots ?? 10;
    this.#now = opts.now ?? Date.now;
  }

  #isExpired(createdAt: number): boolean {
    const now = this.#now();
    return now - createdAt > this.ttlMs || createdAt - now > FUTURE_SKEW_MS;
  }

  async save(meta: SnapshotMeta, tar: Uint8Array): Promise<SnapshotSummary> {
    if (tar.byteLength > MAX_SNAPSHOT_BYTES) throw new Error(`snapshot too large (${tar.byteLength} bytes)`);
    const metaBytes = utf8(JSON.stringify(meta));
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, metaBytes.byteLength);
    let payload = concat([len, metaBytes, tar]);
    const gz = compressionSupported;
    if (gz) payload = await gzip(payload);

    const createdAt = this.#now();
    const envelope = await seal(await this.#keys.getKey(), { v: 1, createdAt, gz, kind: "snapshot" }, payload);
    const id = fileName(createdAt, randomId(8));
    await this.#blobs.write(id, envelope);
    await this.#enforceRetention();
    return { id, createdAt, expiresAt: createdAt + this.ttlMs, sizeBytes: envelope.byteLength };
  }

  /** Newest first. Expired entries are purged as a side effect. */
  async list(): Promise<SnapshotSummary[]> {
    await this.purgeExpired();
    const out: SnapshotSummary[] = [];
    for (const name of await this.#blobs.list()) {
      const parsed = parseName(name);
      if (!parsed) continue;
      // Size isn't in the name; reading files just to size them would defeat a cheap listing.
      out.push({ id: parsed.id, createdAt: parsed.createdAt, expiresAt: parsed.createdAt + this.ttlMs, sizeBytes: -1 });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async latest(): Promise<SnapshotSummary | null> {
    return (await this.list())[0] ?? null;
  }

  async load(id: string): Promise<Snapshot> {
    const parsed = parseName(id);
    if (!parsed) throw new SnapshotUnavailableError(`unknown snapshot id: ${id}`);
    const envelope = await this.#blobs.read(id);
    if (!envelope) throw new SnapshotUnavailableError("snapshot not found");

    const discard = async (reason: string): Promise<never> => {
      await this.#blobs.remove(id);
      throw new SnapshotUnavailableError(reason);
    };

    let header;
    try {
      header = peekHeader(envelope);
    } catch {
      return discard("snapshot is corrupt and was deleted");
    }
    if (header.createdAt !== parsed.createdAt || this.#isExpired(header.createdAt)) {
      return discard("snapshot expired (30-day TTL) and was deleted");
    }

    let plaintext: Uint8Array;
    try {
      ({ plaintext } = await open(await this.#keys.getKey(), envelope, "snapshot"));
    } catch {
      // Not decryptable now means never decryptable (key destroyed or data tampered).
      return discard("snapshot could not be decrypted and was deleted");
    }
    if (header.gz) plaintext = await gunzip(plaintext);

    const metaLen = new DataView(plaintext.buffer, plaintext.byteOffset).getUint32(0);
    const meta = JSON.parse(fromUtf8(plaintext.subarray(4, 4 + metaLen))) as SnapshotMeta;
    if (!isProfileId(meta.profile) || typeof meta.workdir !== "string") return discard("snapshot metadata invalid");
    return {
      id,
      createdAt: header.createdAt,
      expiresAt: header.createdAt + this.ttlMs,
      sizeBytes: envelope.byteLength,
      meta,
      tar: plaintext.subarray(4 + metaLen),
    };
  }

  async remove(id: string): Promise<void> {
    if (parseName(id)) await this.#blobs.remove(id);
  }

  /** Delete every snapshot past its TTL. Returns how many were removed. */
  async purgeExpired(): Promise<number> {
    let removed = 0;
    for (const name of await this.#blobs.list()) {
      const parsed = parseName(name);
      if (parsed && this.#isExpired(parsed.createdAt)) {
        await this.#blobs.remove(name);
        removed++;
      }
    }
    return removed;
  }

  async #enforceRetention(): Promise<void> {
    const names = (await this.#blobs.list()).filter((n) => parseName(n)).sort(); // oldest first
    for (const name of names.slice(0, Math.max(0, names.length - this.#max))) await this.#blobs.remove(name);
  }

  async removeAll(): Promise<void> {
    await this.#blobs.removeAll();
  }
}
