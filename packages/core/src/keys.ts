/**
 * Where the AES-GCM key comes from. Composition point: the stores take any
 * KeyProvider, so a passphrase-derived key can replace the device key without
 * touching persistence code.
 */

export interface KeyProvider {
  getKey(): Promise<CryptoKey>;
  /** Irrecoverably destroy the key. Everything encrypted with it becomes noise (crypto-shredding). */
  destroy(): Promise<void>;
}

const DB_NAME = "aether-mux-keys";
const STORE = "keys";

function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(STORE, mode);
      const op = run(tx.objectStore(STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(op.result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error ?? op.error);
      };
    };
  });
}

/**
 * A random AES-256 key generated with `extractable: false` and kept in
 * IndexedDB as a structured-cloned CryptoKey. Page script can use it but can
 * never read its bytes, so an XSS or a copied profile directory can't simply
 * exfiltrate the raw key alongside the ciphertext. OPFS cannot hold a
 * CryptoKey, which is why the key lives in IndexedDB and the data in OPFS.
 */
export class DeviceKeyProvider implements KeyProvider {
  #cached: Promise<CryptoKey> | null = null;

  readonly id: string;

  constructor(id = "snapshot-key-v1") {
    this.id = id;
  }

  getKey(): Promise<CryptoKey> {
    this.#cached ??= this.#load().catch((err) => {
      this.#cached = null;
      throw err;
    });
    return this.#cached;
  }

  async #load(): Promise<CryptoKey> {
    const existing = await idb<CryptoKey | undefined>("readonly", (s) => s.get(this.id) as IDBRequest<CryptoKey | undefined>);
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    // `add` (not `put`) so two tabs racing on first run can't overwrite each other's key.
    try {
      await idb("readwrite", (s) => s.add(key, this.id));
      return key;
    } catch {
      const winner = await idb<CryptoKey | undefined>("readonly", (s) => s.get(this.id) as IDBRequest<CryptoKey | undefined>);
      if (!winner) throw new Error("could not persist device key");
      return winner;
    }
  }

  async destroy(): Promise<void> {
    this.#cached = null;
    await idb("readwrite", (s) => s.delete(this.id));
  }
}

/**
 * Key derived from a user passphrase (PBKDF2-SHA-256, 600k iterations per
 * OWASP 2023). Nothing is stored: losing the passphrase loses the data.
 * Salt must be stable per installation; store it next to the data (it is not secret).
 */
export class PassphraseKeyProvider implements KeyProvider {
  #key: Promise<CryptoKey> | null = null;

  readonly passphrase: () => Promise<string>;
  readonly salt: Uint8Array<ArrayBuffer>;
  readonly iterations: number;

  constructor(passphrase: () => Promise<string>, salt: Uint8Array<ArrayBuffer>, iterations = 600_000) {
    this.passphrase = passphrase;
    this.salt = salt;
    this.iterations = iterations;
  }

  getKey(): Promise<CryptoKey> {
    this.#key ??= (async () => {
      const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(await this.passphrase()), "PBKDF2", false, [
        "deriveKey",
      ]);
      return crypto.subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt: this.salt, iterations: this.iterations },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    return this.#key;
  }

  async destroy(): Promise<void> {
    this.#key = null;
  }
}
