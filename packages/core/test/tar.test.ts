import { test } from "node:test";
import assert from "node:assert/strict";
import { packTar, unpackTar } from "../src/tar.ts";
import { utf8, fromUtf8 } from "../src/bytes.ts";

test("round-trips files, directories, symlinks and long/unicode paths", () => {
  const long = `${"deep/".repeat(30)}file-ünïcødé.txt`;
  const tar = packTar([
    { path: "src", kind: "directory" },
    { path: "src/index.js", kind: "file", data: utf8("console.log(1)\n"), mode: 0o755 },
    { path: "empty.txt", kind: "file", data: new Uint8Array() },
    { path: "link", kind: "symlink", linkTarget: "src/index.js" },
    { path: long, kind: "file", data: utf8("x") },
  ]);
  assert.equal(tar.byteLength % 512, 0);
  const out = unpackTar(tar);
  assert.deepEqual(
    out.map((e) => [e.path, e.kind]),
    [
      ["src", "directory"],
      ["src/index.js", "file"],
      ["empty.txt", "file"],
      ["link", "symlink"],
      [long, "file"],
    ],
  );
  assert.equal(fromUtf8(out[1]!.data!), "console.log(1)\n");
  assert.equal(out[1]!.mode, 0o755);
  assert.equal(out[3]!.linkTarget, "src/index.js");
  assert.equal(fromUtf8(out[4]!.data!), "x");
});

test("normalises ./ prefixes like GNU tar output", () => {
  const out = unpackTar(packTar([{ path: "./a/./b.txt", kind: "file", data: utf8("b") }]));
  assert.equal(out[0]!.path, "a/b.txt");
});

test("refuses path traversal", () => {
  assert.throws(() => packTar([{ path: "../escape", kind: "file", data: utf8("") }]), /\.\./);
});

test("rejects truncated archives", () => {
  const tar = packTar([{ path: "a.bin", kind: "file", data: new Uint8Array(4096) }]);
  assert.throws(() => unpackTar(tar.subarray(0, 1024)), /truncated/);
});
