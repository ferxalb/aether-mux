import { fromUtf8, utf8 } from "./bytes.ts";
import { open, seal } from "./crypto.ts";
import type { KeyProvider } from "./keys.ts";
import type { BlobStore } from "./opfs.ts";

async function entryName(name: string): Promise<string> {
  // Hash the logical name so the OPFS listing doesn't reveal which services are configured.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(`aether-mux/secret/${name}`)));
  return `k-${Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")}.amx`;
}

/** Small encrypted key/value store for credentials such as the BrowserPod API key. */
export class SecretStore {
  readonly blobs: BlobStore;
  readonly keys: KeyProvider;

  constructor(blobs: BlobStore, keys: KeyProvider) {
    this.blobs = blobs;
    this.keys = keys;
  }

  async get(name: string): Promise<string | null> {
    const file = await entryName(name);
    const envelope = await this.blobs.read(file);
    if (!envelope) return null;
    try {
      const { plaintext } = await open(await this.keys.getKey(), envelope, "secret");
      const record = JSON.parse(fromUtf8(plaintext)) as { name: string; value: string };
      // The name is inside the ciphertext so one secret's file can't be swapped for another's.
      if (record.name !== name || typeof record.value !== "string") throw new Error("mismatch");
      return record.value;
    } catch {
      await this.blobs.remove(file);
      return null;
    }
  }

  async set(name: string, value: string): Promise<void> {
    const envelope = await seal(
      await this.keys.getKey(),
      { v: 1, createdAt: Date.now(), gz: false, kind: "secret" },
      utf8(JSON.stringify({ name, value })),
    );
    await this.blobs.write(await entryName(name), envelope);
  }

  async delete(name: string): Promise<void> {
    await this.blobs.remove(await entryName(name));
  }
}
