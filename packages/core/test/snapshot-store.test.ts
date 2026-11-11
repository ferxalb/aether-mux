import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapshotStore, SnapshotUnavailableError, DAY_MS } from "../src/snapshot-store.ts";
import { MemoryBlobStore } from "../src/opfs.ts";
import { SecretStore } from "../src/secret-store.ts";
import { packTar, unpackTar } from "../src/tar.ts";
import { utf8, fromUtf8 } from "../src/bytes.ts";
import { memoryKey } from "./helpers.ts";

const meta = { profile: "light", workdir: "/home/user", label: "t" } as const;
const tar = packTar([{ path: "a.txt", kind: "file", data: utf8("hello") }]);

function setup(start = Date.UTC(2026, 0, 1)) {
  let now = start;
  const blobs = new MemoryBlobStore();
  const keys = memoryKey();
  const store = new SnapshotStore({ blobs, keys, now: () => now, maxSnapshots: 3 });
  return { store, blobs, keys, advance: (ms: number) => (now += ms) };
}

test("save → list → load round trip, encrypted at rest", async () => {
  const { store, blobs } = setup();
  const s = await store.save(meta, tar);
  const [raw] = await Promise.all([blobs.read(s.id)]);
  assert.ok(raw && !fromUtf8(raw).includes("hello"));
  assert.deepEqual((await store.list()).map((x) => x.id), [s.id]);
  const loaded = await store.load(s.id);
  assert.equal(loaded.meta.profile, "light");
  assert.equal(fromUtf8(unpackTar(loaded.tar)[0]!.data!), "hello");
});

test("snapshots older than 30 days are purged and refused", async () => {
  const { store, blobs, advance } = setup();
  const old = await store.save(meta, tar);
  advance(29 * DAY_MS);
  const fresh = await store.save(meta, tar);
  advance(2 * DAY_MS); // old is now 31 days, fresh is 2 days
  await assert.rejects(store.load(old.id), SnapshotUnavailableError);
  assert.equal(await blobs.read(old.id), null, "expired snapshot must be deleted on load");
  assert.deepEqual((await store.list()).map((x) => x.id), [fresh.id]);
  advance(29 * DAY_MS);
  assert.equal(await store.purgeExpired(), 1);
  assert.deepEqual(await store.list(), []);
});

test("renaming a file to a newer timestamp does not resurrect it", async () => {
  const { store, blobs, advance } = setup();
  const s = await store.save(meta, tar);
  advance(40 * DAY_MS);
  const renamed = `s-${String(Date.UTC(2026, 0, 1) + 40 * DAY_MS).padStart(15, "0")}-0000000000000000.amx`;
  await blobs.write(renamed, (await blobs.read(s.id))!);
  await assert.rejects(store.load(renamed), /expired/);
});

test("retention keeps only the newest N", async () => {
  const { store, advance } = setup();
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    ids.push((await store.save(meta, tar)).id);
    advance(1000);
  }
  assert.deepEqual((await store.list()).map((x) => x.id), ids.slice(2).reverse());
});

test("destroying the key makes snapshots unrecoverable (crypto-shredding)", async () => {
  const { store, keys } = setup();
  const s = await store.save(meta, tar);
  await keys.rotate();
  await assert.rejects(store.load(s.id), /could not be decrypted/);
});

test("secret store round trip and name binding", async () => {
  const blobs = new MemoryBlobStore();
  const secrets = new SecretStore(blobs, memoryKey());
  await secrets.set("a", "1");
  await secrets.set("b", "2");
  assert.equal(await secrets.get("a"), "1");
  const [fa, fb] = await blobs.list();
  // Swap the two files: each must now be rejected, not returned under the wrong name.
  const [da, db] = [await blobs.read(fa!), await blobs.read(fb!)];
  await blobs.write(fa!, db!);
  await blobs.write(fb!, da!);
  assert.equal(await secrets.get("a"), null);
  assert.equal(await secrets.get("b"), null);
});
