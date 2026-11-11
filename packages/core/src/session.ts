import type { SnapshotStore, SnapshotSummary } from "./snapshot-store.ts";
import { scopeTerminal, type Terminal } from "./terminal.ts";
import type { Disposable, ProfileId, Runtime, RuntimeLoader, SecretProvider } from "./types.ts";

export type SessionState = "idle" | "booting" | "ready" | "busy" | "error";

export interface SessionStatus {
  readonly state: SessionState;
  readonly profile: ProfileId | null;
  readonly message: string;
}

export interface SessionOptions {
  readonly terminal: Terminal;
  readonly loaders: Readonly<Record<ProfileId, RuntimeLoader>>;
  readonly snapshots: SnapshotStore;
  readonly secrets: SecretProvider;
  readonly workdir: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly onStatus?: (status: SessionStatus) => void;
}

/**
 * Owns the single active runtime and everything that must happen in order
 * around it (boot, attach, switch, snapshot, restore). All public operations
 * are serialised so, e.g., a snapshot can't race a profile switch.
 */
export class Session {
  #runtime: Runtime | null = null;
  #attachment: Disposable | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #status: SessionStatus = { state: "idle", profile: null, message: "" };
  /** Workspace exported from a runtime whose successor failed to boot; imported by the next successful boot. */
  #stranded: Uint8Array | null = null;

  readonly opts: SessionOptions;

  constructor(opts: SessionOptions) {
    this.opts = opts;
  }

  get runtime(): Runtime | null {
    return this.#runtime;
  }

  get status(): SessionStatus {
    return this.#status;
  }

  #setStatus(state: SessionState, message: string): void {
    this.#status = { state, profile: this.#runtime?.profile ?? this.#status.profile, message };
    this.opts.onStatus?.(this.#status);
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }

  start(profile: ProfileId): Promise<void> {
    return this.#serial(() => this.#boot(profile, null));
  }

  /**
   * Swap runtimes. The workspace travels across as a tar archive held only in
   * memory, so switching never writes plaintext anywhere.
   */
  switchProfile(profile: ProfileId): Promise<void> {
    return this.#serial(async () => {
      if (this.#runtime?.profile === profile) return;
      let carried: Uint8Array | null = null;
      if (this.#runtime) {
        this.#setStatus("busy", "Exporting workspace…");
        try {
          carried = await this.#runtime.exportWorkspace();
        } catch (err) {
          this.opts.terminal.notice(`Could not carry workspace across: ${errorMessage(err)}`, "warn");
        }
        await this.#teardown();
      }
      await this.#boot(profile, carried);
    });
  }

  snapshot(label = ""): Promise<SnapshotSummary> {
    return this.#serial(async () => {
      const rt = this.#requireRuntime();
      this.#setStatus("busy", "Encrypting snapshot…");
      try {
        const tar = await rt.exportWorkspace();
        const summary = await this.opts.snapshots.save({ profile: rt.profile, workdir: rt.workdir, label }, tar);
        this.#setStatus("ready", "Snapshot saved");
        return summary;
      } catch (err) {
        this.#setStatus("ready", `Snapshot failed: ${errorMessage(err)}`);
        throw err;
      }
    });
  }

  restore(id: string): Promise<void> {
    return this.#serial(async () => {
      const rt = this.#requireRuntime();
      this.#setStatus("busy", "Decrypting snapshot…");
      try {
        const snap = await this.opts.snapshots.load(id);
        await rt.importWorkspace(snap.tar);
        this.#setStatus("ready", `Restored snapshot from ${new Date(snap.createdAt).toLocaleString()}`);
      } catch (err) {
        this.#setStatus("ready", `Restore failed: ${errorMessage(err)}`);
        throw err;
      }
    });
  }

  stop(): Promise<void> {
    return this.#serial(() => this.#teardown());
  }

  #requireRuntime(): Runtime {
    if (!this.#runtime || this.#status.state === "error") throw new Error("no runtime is running");
    return this.#runtime;
  }

  async #boot(profile: ProfileId, incoming: Uint8Array | null): Promise<void> {
    const { terminal } = this.opts;
    const carried = incoming ?? this.#stranded;
    this.#status = { ...this.#status, profile };
    this.#setStatus("booting", `Loading ${profile} runtime…`);
    try {
      const mod = await this.opts.loaders[profile]();
      const runtime = mod.createRuntime({
        workdir: this.opts.workdir,
        secrets: this.opts.secrets,
        ...(this.opts.env ? { env: this.opts.env } : {}),
        log: (m) => this.#setStatus("booting", m),
      });
      this.#runtime = runtime;
      this.#setStatus("booting", `Booting ${profile} runtime…`);
      await runtime.boot();
      if (carried) {
        this.#setStatus("booting", "Restoring workspace…");
        await runtime.importWorkspace(carried);
        this.#stranded = null;
      }
      // Separator instead of clear(): keep earlier output, including why a previous boot failed.
      terminal.write(`\r\n\x1b[2m── ${profile} · ${runtime.capabilities.realBash ? "bash" : "nodepod shell"} · ${this.opts.workdir} ──\x1b[0m\r\n`);
      const scoped = scopeTerminal(terminal);
      const shell = await runtime.attachTerminal(scoped);
      this.#attachment = {
        dispose: () => {
          shell.dispose();
          scoped.dispose();
        },
      };
      terminal.focus();
      this.#setStatus("ready", `${profile} runtime ready`);
    } catch (err) {
      if (carried) this.#stranded = carried;
      terminal.notice(`Failed to start ${profile} runtime: ${errorMessage(err)}`, "error");
      await this.#teardown();
      this.#status = { state: "error", profile, message: errorMessage(err) };
      this.opts.onStatus?.(this.#status);
      throw err;
    }
  }

  async #teardown(): Promise<void> {
    this.#attachment?.dispose();
    this.#attachment = null;
    const rt = this.#runtime;
    this.#runtime = null;
    if (rt) {
      try {
        await rt.dispose();
      } catch (err) {
        console.warn("[aether-mux] runtime dispose failed", err);
      }
    }
    this.#setStatus("idle", "");
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
