import type { KeyProvider } from "../src/keys.ts";

/** In-memory KeyProvider for tests (DeviceKeyProvider needs IndexedDB). */
export function memoryKey(): KeyProvider & { rotate(): Promise<void> } {
  let key: Promise<CryptoKey> | null = null;
  const fresh = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return {
    getKey: () => (key ??= fresh()),
    destroy: async () => {
      key = null;
    },
    rotate: async () => {
      key = fresh();
    },
  };
}
