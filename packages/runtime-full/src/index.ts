/**
 * Full profile: BrowserPod.
 *
 * A Wasm Linux-compatible kernel with real bash, git, Node.js and npm, plus
 * Wasm-compiled Rust CLIs. Heavier to download and boot, requires a
 * cross-origin isolated page and a BrowserPod API key.
 */
import type { BinaryFile, BrowserPod, Terminal as PodTerminal } from "@leaningtech/browserpod";
import {
  randomId,
  SNAPSHOT_EXCLUDED_DIRS,
  toBufferSource,
  unpackTar,
  type Disposable,
  type ExecOptions,
  type ExecResult,
  type Runtime,
  type RuntimeCapabilities,
  type RuntimeOptions,
  type TerminalIO,
} from "@aether-mux/core";

const CAPABILITIES: RuntimeCapabilities = {
  realBash: true,
  git: true,
  nativeBinaries: true,
  // BrowserPod's custom terminal takes cols/rows only at creation; there is no resize call.
  resize: false,
  requiresCrossOriginIsolation: true,
  releasesOnDispose: false,
};

export const API_KEY_SECRET = "browserpod.apiKey";

export interface FullRuntimeOptions extends RuntimeOptions {
  readonly nodeVersion?: string;
}

const READ_CHUNK = 1 << 20;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

class FullRuntime implements Runtime {
  readonly profile = "full" as const;
  readonly capabilities = CAPABILITIES;
  readonly workdir: string;
  #pod: BrowserPod | null = null;
  #disposed = false;

  readonly opts: FullRuntimeOptions;

  constructor(opts: FullRuntimeOptions) {
    this.opts = opts;
    this.workdir = opts.workdir;
  }

  #requirePod(): BrowserPod {
    if (!this.#pod) throw new Error("full runtime is not booted");
    return this.#pod;
  }

  async boot(): Promise<void> {
    if (this.#pod) return;
    if (!globalThis.crossOriginIsolated) {
      throw new Error(
        "BrowserPod needs SharedArrayBuffer. Serve the app with " +
          "Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.",
      );
    }
    const apiKey = await this.opts.secrets.get(
      API_KEY_SECRET,
      "BrowserPod API key (free for personal/open-source use at console.browserpod.io). Stored encrypted on this device only.",
    );
    if (!apiKey) throw new Error("a BrowserPod API key is required for the full profile");

    this.opts.log?.("Downloading BrowserPod runtime…");
    // The npm package is a thin loader that imports the engine from
    // rt.browserpod.io at module-evaluation time, so this import is the network fetch.
    const { BrowserPod } = await import("@leaningtech/browserpod");
    if (!BrowserPod) throw new Error("BrowserPod engine failed to load (network or CSP blocked rt.browserpod.io)");

    this.opts.log?.("Booting BrowserPod…");
    // `storageKey` is deliberately omitted: with it, BrowserPod persists the
    // disk to IndexedDB in plaintext. We keep the pod ephemeral and persist
    // only through our encrypted snapshots.
    this.#pod = await BrowserPod.boot({
      apiKey,
      ...(this.opts.nodeVersion ? { nodeVersion: this.opts.nodeVersion } : {}),
    });
    await this.#pod.createDirectory(this.workdir, { recursive: true });
  }

  #env(extra?: Readonly<Record<string, string>>): string[] {
    const env = { HOME: this.workdir, TERM: "xterm-256color", ...this.opts.env, ...extra };
    return Object.entries(env).map(([k, v]) => `${k}=${v}`);
  }

  async attachTerminal(io: TerminalIO): Promise<Disposable> {
    const pod = this.#requirePod();
    let detached = false;
    const term: PodTerminal = await pod.createCustomTerminal({
      cols: io.cols,
      rows: io.rows,
      onOutput: (buf) => {
        if (!detached) io.write(new Uint8Array(buf));
      },
    });
    // For custom terminals, Terminal.write() is the guest's stdin.
    const input = io.onData((data) => {
      if (!detached) term.write(data);
    });

    const loop = async (): Promise<void> => {
      while (!detached && !this.#disposed) {
        try {
          await pod.run("/bin/bash", ["--login", "-i"], { terminal: term, cwd: this.workdir, env: this.#env() });
        } catch (err) {
          io.write(`\r\n\x1b[31mshell failed: ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`);
          return;
        }
        if (!detached && !this.#disposed) io.write("\r\n\x1b[2m[shell exited, restarting]\x1b[0m\r\n");
      }
    };
    void loop();

    return {
      dispose: () => {
        detached = true;
        input.dispose();
      },
    };
  }

  async exec(command: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    const pod = this.#requirePod();
    let output = "";
    const decoder = new TextDecoder();
    const term = await pod.createCustomTerminal({
      onOutput: (buf) => {
        const text = decoder.decode(new Uint8Array(buf), { stream: true });
        output += text;
        options.onOutput?.(text);
      },
    });
    const run = pod.run(command, [...args], {
      terminal: term,
      cwd: options.cwd ?? this.workdir,
      env: this.#env(options.env),
      echo: false,
    });
    if (options.signal) {
      // BrowserPod exposes no kill(); the best we can do is stop waiting.
      await Promise.race([
        run,
        new Promise((_, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true })),
      ]);
    } else {
      await run;
    }
    // BrowserPod's Process handle is opaque: no exit status is reported.
    return { output, exitCode: null };
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const pod = this.#requirePod();
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) await pod.createDirectory(dir, { recursive: true });
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : toBufferSource(data);
    const file = (await pod.createFile(path, "binary")) as BinaryFile;
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const end = Math.min(offset + READ_CHUNK, bytes.byteLength);
        const chunk = bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + end);
        const n = await file.write(chunk);
        if (n <= 0) throw new Error(`short write to ${path}`);
        offset += n;
      }
    } finally {
      await file.close();
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const pod = this.#requirePod();
    const file = (await pod.openFile(path, "binary")) as BinaryFile;
    try {
      const size = await file.getSize();
      const out = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const chunk = new Uint8Array(await file.read(Math.min(READ_CHUNK, size - offset)));
        if (chunk.byteLength === 0) break;
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return offset === size ? out : out.subarray(0, offset);
    } finally {
      await file.close();
    }
  }

  async exportWorkspace(): Promise<Uint8Array> {
    const archive = `/tmp/aether-export-${randomId(6)}.tar`;
    const excludes = SNAPSHOT_EXCLUDED_DIRS.map((d) => `--exclude=${shellQuote(d)}`).join(" ");
    // pax handles arbitrarily long paths (ustar silently drops them); plain
    // `tar` is the fallback for busybox, whose GNU-style long names we also read.
    const script = `tar --format=pax ${excludes} -cf ${shellQuote(archive)} -C ${shellQuote(this.workdir)} . 2>&1 || tar ${excludes} -cf ${shellQuote(archive)} -C ${shellQuote(this.workdir)} .`;
    const { output } = await this.exec("/bin/bash", ["-c", script]);
    try {
      const tar = await this.readFile(archive);
      // Validate before handing it to the snapshot store: a truncated archive
      // would otherwise be encrypted and kept as if it were good.
      unpackTar(tar);
      return tar;
    } catch (err) {
      throw new Error(`workspace export failed: ${output.trim() || (err instanceof Error ? err.message : String(err))}`);
    } finally {
      await this.exec("/bin/rm", ["-f", archive]).catch(() => {});
    }
  }

  async importWorkspace(tar: Uint8Array): Promise<void> {
    unpackTar(tar); // reject traversal / corrupt archives before they reach the guest's tar
    const archive = `/tmp/aether-import-${randomId(6)}.tar`;
    await this.writeFile(archive, tar);
    const keep = SNAPSHOT_EXCLUDED_DIRS.map((d) => `! -name ${shellQuote(d)}`).join(" ");
    const wd = shellQuote(this.workdir);
    const script =
      `find ${wd} -mindepth 1 -maxdepth 1 ${keep} -exec rm -rf {} + && ` +
      `tar -xf ${shellQuote(archive)} -C ${wd} --no-same-owner; s=$?; rm -f ${shellQuote(archive)}; ` +
      `[ $s -eq 0 ] && echo __AETHER_OK__`;
    const { output } = await this.exec("/bin/bash", ["-c", script]);
    // exitCode is unavailable on BrowserPod, so success is signalled in-band.
    if (!output.includes("__AETHER_OK__")) throw new Error(`workspace import failed: ${output.trim()}`);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    // BrowserPod has no teardown API; dropping the reference lets its workers be
    // collected. A page reload is the only guaranteed full release.
    this.#pod = null;
  }
}

export function createRuntime(options: FullRuntimeOptions): Runtime {
  return new FullRuntime(options);
}
