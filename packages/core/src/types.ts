/**
 * The contract every runtime profile implements. The app and the session only
 * ever talk to a `Runtime`; Nodepod / BrowserPod types never leak past their
 * adapter packages, which is what lets the app lazy-load them independently.
 */

export type ProfileId = "light" | "full";

export const PROFILES: readonly ProfileId[] = ["light", "full"] as const;

export function isProfileId(value: unknown): value is ProfileId {
  return value === "light" || value === "full";
}

export interface Disposable {
  dispose(): void;
}

/** What a runtime can do. Surfaced in the UI so users know which profile to pick. */
export interface RuntimeCapabilities {
  /** A real bash (vs. a bash-like interpreter written in JS). */
  readonly realBash: boolean;
  /** `git` available on PATH. */
  readonly git: boolean;
  /** Can execute non-JS binaries (Wasm-compiled Linux userland, Rust CLIs...). */
  readonly nativeBinaries: boolean;
  /** The guest receives terminal size changes. */
  readonly resize: boolean;
  /** Requires `crossOriginIsolated` (COOP/COEP headers) to boot at all. */
  readonly requiresCrossOriginIsolation: boolean;
  /**
   * `dispose()` frees the engine's workers and memory. When false, the only way
   * to reclaim them is a page reload, so the app switches away via
   * snapshot + reload instead of an in-page swap.
   */
  readonly releasesOnDispose: boolean;
}

/**
 * Byte/str stream between the terminal emulator and a guest process.
 * Implemented by core's wterm wrapper; consumed by runtimes.
 */
export interface TerminalIO {
  readonly cols: number;
  readonly rows: number;
  /** Write guest output to the screen. */
  write(data: string | Uint8Array): void;
  /** Subscribe to user keystrokes / terminal responses (already UTF-8 decoded). */
  onData(listener: (data: string) => void): Disposable;
  onResize(listener: (cols: number, rows: number) => void): Disposable;
  focus(): void;
  clear(): void;
}

/** Resolves secrets (API keys) without the runtime knowing where they live. */
export interface SecretProvider {
  /**
   * Return the secret, or null if the user declined to provide one.
   * `description` is shown to the user if they have to be asked.
   */
  get(name: string, description: string): Promise<string | null>;
}

export interface RuntimeOptions {
  /** Absolute guest path that holds the user's files and is what snapshots capture. */
  readonly workdir: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly secrets: SecretProvider;
  /** Progress / diagnostics for the status line. Never sent anywhere. */
  readonly log?: (message: string) => void;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Streamed output (stdout and stderr interleaved as the runtime provides it). */
  readonly onOutput?: (chunk: string) => void;
  readonly signal?: AbortSignal;
}

export interface ExecResult {
  readonly output: string;
  /** null when the runtime cannot report exit status (BrowserPod's Process is opaque). */
  readonly exitCode: number | null;
}

export interface Runtime {
  readonly profile: ProfileId;
  readonly capabilities: RuntimeCapabilities;
  readonly workdir: string;

  boot(): Promise<void>;

  /**
   * Run an interactive shell wired to `io` until the returned handle is disposed.
   * The runtime must dispose every listener it registered on `io` when the
   * handle is disposed, so the same terminal can be handed to the next runtime.
   */
  attachTerminal(io: TerminalIO): Promise<Disposable>;

  /** Run a single non-interactive command. */
  exec(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult>;

  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;

  /**
   * Capture `workdir` as a POSIX ustar archive (node_modules excluded).
   * Tar is the neutral format, so a snapshot taken in one profile restores in the other.
   */
  exportWorkspace(): Promise<Uint8Array>;
  /** Replace `workdir` contents with the archive's. */
  importWorkspace(tar: Uint8Array): Promise<void>;

  dispose(): Promise<void>;
}

export type RuntimeFactory = (options: RuntimeOptions) => Runtime;

/** A module that exports a runtime factory; what the app's dynamic imports resolve to. */
export interface RuntimeModule {
  readonly createRuntime: RuntimeFactory;
}

export type RuntimeLoader = () => Promise<RuntimeModule>;

/** Directories never captured in snapshots: reproducible from package.json, and often huge. */
export const SNAPSHOT_EXCLUDED_DIRS: readonly string[] = ["node_modules", ".npm", ".cache"];
