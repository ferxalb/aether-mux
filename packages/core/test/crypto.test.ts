import { test } from "node:test";
import assert from "node:assert/strict";
import { open, peekHeader, seal, EnvelopeError } from "../src/crypto.ts";
import { utf8, fromUtf8 } from "../src/bytes.ts";
import { memoryKey } from "./helpers.ts";

const header = { v: 1, createdAt: 1_700_000_000_000, gz: false, kind: "snapshot" } as const;

test("seal/open round trip with a unique IV per message", async () => {
  const key = await memoryKey().getKey();
  const a = await seal(key, header, utf8("secret"));
  const b = await seal(key, header, utf8("secret"));
  assert.notDeepEqual(a, b);
  assert.ok(!fromUtf8(a).includes("secret"));
  assert.equal(fromUtf8((await open(key, a, "snapshot")).plaintext), "secret");
});

test("tampering with the clear header (e.g. extending TTL) breaks authentication", async () => {
  const key = await memoryKey().getKey();
  const env = await seal(key, header, utf8("payload"));
  const text = new TextDecoder("latin1").decode(env);
  const forgedTs = String(header.createdAt + 1); // same length, different value
  const forged = Uint8Array.from(text.replace(String(header.createdAt), forgedTs), (c) => c.charCodeAt(0));
  assert.equal(peekHeader(forged).createdAt, header.createdAt + 1);
  await assert.rejects(open(key, forged, "snapshot"), EnvelopeError);
});

test("ciphertext bit flips and wrong keys are rejected", async () => {
  const k1 = memoryKey();
  const env = await seal(await k1.getKey(), header, utf8("payload"));
  const flipped = env.slice();
  flipped[flipped.length - 20]! ^= 1;
  await assert.rejects(open(await k1.getKey(), flipped, "snapshot"), EnvelopeError);
  await assert.rejects(open(await memoryKey().getKey(), env, "snapshot"), EnvelopeError);
});

test("an envelope cannot be opened as a different kind", async () => {
  const key = await memoryKey().getKey();
  const env = await seal(key, { ...header, kind: "secret" }, utf8("k"));
  await assert.rejects(open(key, env, "snapshot"), /expected snapshot/);
});
