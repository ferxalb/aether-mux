/// <reference lib="webworker" />
/**
 * OPFS writer for browsers that only expose `createSyncAccessHandle()`
 * (Safari before 26). Spawned lazily by OpfsBlobStore; never used elsewhere.
 */

type WriteRequest = { id: number; dir: string[]; name: string; data: Uint8Array<ArrayBuffer> };

interface SyncAccessHandle {
  truncate(size: number): void;
  write(buffer: BufferSource, opts?: { at?: number }): number;
  flush(): void;
  close(): void;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (ev: MessageEvent<WriteRequest>) => {
  const { id, dir, name, data } = ev.data;
  let handle: SyncAccessHandle | null = null;
  try {
    let d = await navigator.storage.getDirectory();
    for (const part of dir) d = await d.getDirectoryHandle(part, { create: true });
    const file = await d.getFileHandle(name, { create: true });
    handle = await (file as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandle> }).createSyncAccessHandle();
    handle.truncate(0);
    let written = 0;
    while (written < data.byteLength) written += handle.write(data.subarray(written), { at: written });
    handle.flush();
    scope.postMessage({ id, ok: true });
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    handle?.close();
  }
};
