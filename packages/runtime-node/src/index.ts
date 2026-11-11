/**
 * Light profile: Nodepod.
 *
 * Node.js APIs are polyfilled and every process runs in its own Web Worker;
 * the shell is Nodepod's bash-compatible interpreter written in JS. That keeps
 * the download small and boot near-instant, at the cost of anything that needs
 * a real native/Wasm binary (see README "Profile limitations").
 */
import type { Nodepod } from "@r1ck404/nodepod";
import {
  packTar,
  SNAPSHOT_EXCLUDED_DIRS,
  unpackTar,
  utf8,
  type Disposable,
  type ExecOptions,
  type ExecResult,
  type Runtime,
  type RuntimeCapabilities,
  type RuntimeOptions,
  type TarEntry,
  type TerminalIO,
} from "@aether-mux/core";
import { xtermShimFor } from "./xterm-shim.ts";

const CAPABILITIES: RuntimeCapabilities = {
  realBash: false,
  git: false,
  nativeBinaries: false,
  resize: true,
  requiresCrossOriginIsolation: false,
  releasesOnDispose: true,
};

export interface NodeRuntimeOptions extends RuntimeOptions {
  /**
   * Let Nodepod cache installed packages in IndexedDB between sessions. Off by
   * default: that cache is unencrypted and could hold private packages, which
   * would break the "everything at rest is encrypted" guarantee.
   */
  readonly cachePackages?: boolean;
  /** URL of Nodepod's worker bundle; the Vite plugin serves it at /__worker__.js. */
  readonly workerUrl?: string;
}

/**
 * Nodepod always persists a module-transform cache (transformed source, which
 * may include the user's own code) to this IndexedDB database in plaintext and
 * exposes no option to disable it. In strict mode we delete it at the start of
 * each page's first light boot, which bounds that plaintext to the lifetime of
 * one session.
 *
 * Deleting is only safe before anything has opened the database: a delete
 * queued behind an open connection would stall the next open. So it runs at
 * most once per page, and only when no other tab holds the session lock.
 */
const PLAINTEXT_CACHE_DBS = ["nodepod-transforms"];
const SESSION_LOCK = "aether-mux:nodepod-session";
let purgedThisPage = false;

async function otherSessionActive(): Promise<boolean> {
  // Without Web Locks we can't know, so assume yes and leave the cache alone.
  if (!navigator.locks) return true;
  const { held = [] } = await navigator.locks.query();
  return held.some((l) => l.name === SESSION_LOCK);
}

function holdSessionLock(): () => void {
  let release: () => void = () => {};
  const done = new Promise<void>((r) => (release = r));
  void navigator.locks?.request(SESSION_LOCK, { mode: "shared" }, () => done);
  return release;
}

async function purgePlaintextCaches(): Promise<void> {
  if (purgedThisPage || typeof indexedDB === "undefined") return;
  purgedThisPage = true;
  if (await otherSessionActive()) return;
  await Promise.all(
    PLAINTEXT_CACHE_DBS.map(
      (name) =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        }),
    ),
  );
}

// NodepodFS.readFile returns bytes when called without an encoding, but its
// overloads are declared in an order that makes TS pick the string one.
function readBytes(pod: Nodepod, path: string): Promise<Uint8Array> {
  return (pod.fs.readFile as (p: string) => Promise<Uint8Array>).call(pod.fs, path);
}

class NodeRuntime implements Runtime {
  readonly profile = "light" as const;
  readonly capabilities = CAPABILITIES;
  readonly workdir: string;
  #pod: Nodepod | null = null;
  #releaseLock: () => void = () => {};

  readonly opts: NodeRuntimeOptions;

  constructor(opts: NodeRuntimeOptions) {
    this.opts = opts;
    this.workdir = opts.workdir;
  }

  #requirePod(): Nodepod {
    if (!this.#pod) throw new Error("light runtime is not booted");
    return this.#pod;
  }

  async boot(): Promise<void> {
    if (this.#pod) return;
    this.opts.log?.("Loading Nodepod…");
    const { Nodepod } = await import("@r1ck404/nodepod");
    const strict = !this.opts.cachePackages;
    if (strict) await purgePlaintextCaches();
    this.#releaseLock = holdSessionLock();
    this.#pod = await Nodepod.boot({
      workdir: this.workdir,
      env: { HOME: this.workdir, TERM: "xterm-256color", ...this.opts.env },
      // No preview service worker: it is only needed to serve dev-server
      // previews, costs boot time, and would contend with the app's own SW scope.
      serviceWorker: false,
      watermark: false,
      enableSnapshotCache: !strict,
      packageStore: strict ? "memory" : "auto",
      // Shared memory unlocks execSync/spawnSync and threaded Wasm tools; it is
      // only available when the page is cross-origin isolated.
      enableSharedArrayBuffer: globalThis.crossOriginIsolated === true,
      ...(this.opts.workerUrl ? { workerUrl: this.opts.workerUrl } : {}),
    });
    await this.#pod.fs.mkdir(this.workdir, { recursive: true });
  }

  async attachTerminal(io: TerminalIO): Promise<Disposable> {
    const pod = this.#requirePod();
    // Nodepod's terminal owns the line editor, history, tab completion and the
    // persistent shell process (cwd/env survive between commands). It drives an
    // xterm.js-shaped object, so we hand it a shim over our wterm instead of
    // reimplementing any of that.
    const shim = xtermShimFor(io);
    const term = pod.createTerminal({
      Terminal: shim.Terminal,
      prompt: (cwd: string) => `\x1b[1;32maether\x1b[0m:\x1b[1;34m${cwd.replace(this.workdir, "~")}\x1b[0m$ `,
    });
    term.attach(shim.mountPoint);
    return {
      dispose: () => {
        term.detach();
        shim.dispose();
      },
    };
  }

  async exec(command: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    const pod = this.#requirePod();
    const proc = await pod.spawn(command, [...args], {
      cwd: options.cwd ?? this.workdir,
      ...(options.env ? { env: { ...options.env } } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (options.onOutput) {
      proc.on("output", options.onOutput);
      proc.on("error", options.onOutput);
    }
    const { stdout, stderr, exitCode } = await proc.completion;
    return { output: stdout + stderr, exitCode };
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const pod = this.#requirePod();
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) await pod.fs.mkdir(dir, { recursive: true });
    await pod.fs.writeFile(path, data);
  }

  async readFile(path: string): Promise<Uint8Array> {
    return readBytes(this.#requirePod(), path);
  }

  async exportWorkspace(): Promise<Uint8Array> {
    const pod = this.#requirePod();
    const entries: TarEntry[] = [];
    const walk = async (abs: string, rel: string): Promise<void> => {
      for (const name of (await pod.fs.readdir(abs)).sort()) {
        if (SNAPSHOT_EXCLUDED_DIRS.includes(name)) continue;
        const childAbs = `${abs}/${name}`;
        const childRel = rel ? `${rel}/${name}` : name;
        const st = await pod.fs.stat(childAbs);
        const mtime = Math.floor(st.mtime / 1000);
        if (st.isDirectory) {
          entries.push({ path: childRel, kind: "directory", mtime });
          await walk(childAbs, childRel);
        } else if (st.isFile) {
          entries.push({ path: childRel, kind: "file", mtime, data: await readBytes(pod, childAbs) });
        }
      }
    };
    await walk(this.workdir, "");
    return packTar(entries);
  }

  async importWorkspace(tar: Uint8Array): Promise<void> {
    const pod = this.#requirePod();
    const entries = unpackTar(tar);
    for (const name of await pod.fs.readdir(this.workdir)) {
      // Keep installed packages: they are excluded from snapshots, and wiping
      // them would force a reinstall the user didn't ask for.
      if (!SNAPSHOT_EXCLUDED_DIRS.includes(name)) await pod.fs.rm(`${this.workdir}/${name}`, { recursive: true, force: true });
    }
    for (const e of entries) {
      const abs = `${this.workdir}/${e.path}`;
      if (e.kind === "directory") await pod.fs.mkdir(abs, { recursive: true });
      else if (e.kind === "file") await this.writeFile(abs, e.data ?? utf8(""));
      // Symlinks are skipped: NodepodFS exposes no symlink API.
    }
  }

  async dispose(): Promise<void> {
    const pod = this.#pod;
    this.#pod = null;
    await pod?.teardown();
    this.#releaseLock();
  }
}

export function createRuntime(options: NodeRuntimeOptions): Runtime {
  return new NodeRuntime(options);
}
