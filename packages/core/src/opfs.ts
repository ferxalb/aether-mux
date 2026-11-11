/**
 * Flat file store in a sub-directory of the Origin Private File System.
 *
 * OPFS is per-origin, invisible to the user's file manager and to other
 * origins, and is cleared with site data. Everything written here is already
 * ciphertext; this module only moves bytes.
 */
import { toBufferSource } from "./bytes.ts";

export interface BlobStore {
  list(): Promise<string[]>;
  read(name: string): Promise<Uint8Array | null>;
  /** Atomic where the browser allows it (createWritable); otherwise rely on envelope authentication to detect torn writes. */
  write(name: string, data: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  removeAll(): Promise<void>;
}

export function opfsSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

function assertName(name: string): void {
  if (!SAFE_NAME.test(name) || name.startsWith(".")) throw new Error(`invalid store entry name: ${name}`);
}

type WorkerRequest = { id: number; dir: string[]; name: string; data: Uint8Array<ArrayBuffer> };
type WorkerResponse = { id: number; ok: true } | { id: number; ok: false; error: string };

/**
 * Safari < 26 has no `FileSystemFileHandle.createWritable()` on the main thread;
 * the only write path there is `createSyncAccessHandle()`, which exists only in
 * dedicated workers. We spin that worker up lazily, and only on such browsers.
 */
class SyncHandleWriter {
  #worker: Worker | null = null;
  #next = 0;
  #pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();

  write(dir: string[], name: string, data: Uint8Array): Promise<void> {
    if (!this.#worker) {
      this.#worker = new Worker(new URL("./opfs-worker.ts", import.meta.url), { type: "module", name: "aether-opfs" });
      this.#worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const p = this.#pending.get(ev.data.id);
        if (!p) return;
        this.#pending.delete(ev.data.id);
        if (ev.data.ok) p.resolve();
        else p.reject(new Error(ev.data.error));
      };
      this.#worker.onerror = (ev) => {
        const err = new Error(`OPFS worker failed: ${ev.message}`);
        for (const p of this.#pending.values()) p.reject(err);
        this.#pending.clear();
        this.#worker?.terminate();
        this.#worker = null;
      };
    }
    const id = ++this.#next;
    const payload = toBufferSource(data);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const msg: WorkerRequest = { id, dir, name, data: payload };
      // Copy rather than transfer: callers may still hold the buffer.
      this.#worker!.postMessage(msg);
    });
  }
}

const syncWriter = new SyncHandleWriter();

export class OpfsBlobStore implements BlobStore {
  readonly path: readonly string[];

  constructor(path: readonly string[]) {
    this.path = path;
    for (const p of path) assertName(p);
  }

  async #dir(create = true): Promise<FileSystemDirectoryHandle | null> {
    let dir = await navigator.storage.getDirectory();
    for (const part of this.path) {
      try {
        dir = await dir.getDirectoryHandle(part, { create });
      } catch (err) {
        if (!create && (err as DOMException).name === "NotFoundError") return null;
        throw err;
      }
    }
    return dir;
  }

  async list(): Promise<string[]> {
    const dir = await this.#dir(false);
    if (!dir) return [];
    const names: string[] = [];
    // `entries()` isn't in every lib.dom version yet; go through the async iterator protocol.
    const iterable = dir as unknown as AsyncIterable<[string, FileSystemHandle]>;
    for await (const [name, handle] of iterable) {
      if (handle.kind === "file" && !name.startsWith(".")) names.push(name);
    }
    return names.sort();
  }

  async read(name: string): Promise<Uint8Array | null> {
    assertName(name);
    const dir = await this.#dir(false);
    if (!dir) return null;
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      if ((err as DOMException).name === "NotFoundError") return null;
      throw err;
    }
  }

  async write(name: string, data: Uint8Array): Promise<void> {
    assertName(name);
    const dir = (await this.#dir(true))!;
    const handle = await dir.getFileHandle(name, { create: true });
    if (typeof (handle as Partial<FileSystemFileHandle>).createWritable === "function") {
      // createWritable writes to a swap file and atomically replaces on close().
      const w = await handle.createWritable({ keepExistingData: false });
      try {
        await w.write(toBufferSource(data));
        await w.close();
      } catch (err) {
        await w.abort().catch(() => {});
        throw err;
      }
      return;
    }
    // The sync-handle path is not atomic. That is acceptable because every
    // caller stores AES-GCM envelopes under fresh names: a torn write fails
    // authentication on read and the snapshot store deletes it.
    await syncWriter.write([...this.path], name, data);
  }

  async remove(name: string): Promise<void> {
    assertName(name);
    const dir = await this.#dir(false);
    if (!dir) return;
    try {
      await dir.removeEntry(name);
    } catch (err) {
      if ((err as DOMException).name !== "NotFoundError") throw err;
    }
  }

  async removeAll(): Promise<void> {
    const parentPath = this.path.slice(0, -1);
    const leaf = this.path[this.path.length - 1];
    if (!leaf) return;
    let dir = await navigator.storage.getDirectory();
    try {
      for (const part of parentPath) dir = await dir.getDirectoryHandle(part);
      await dir.removeEntry(leaf, { recursive: true });
    } catch (err) {
      if ((err as DOMException).name !== "NotFoundError") throw err;
    }
  }
}

/** In-memory fallback (private browsing modes without OPFS, tests). Nothing touches disk. */
export class MemoryBlobStore implements BlobStore {
  readonly #files = new Map<string, Uint8Array>();
  async list() {
    return [...this.#files.keys()].sort();
  }
  async read(name: string) {
    return this.#files.get(name)?.slice() ?? null;
  }
  async write(name: string, data: Uint8Array) {
    assertName(name);
    this.#files.set(name, data.slice());
  }
  async remove(name: string) {
    this.#files.delete(name);
  }
  async removeAll() {
    this.#files.clear();
  }
}

/** Ask the browser not to evict our origin's storage under pressure. Best effort; no prompt on most browsers. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
