# AETHER Mux

A local-first terminal that runs entirely in the browser. It's a static SPA (no server, optional PWA) with two runtime profiles built on a shared core:

| Profile | Engine | What runs | Cost |
|---|---|---|---|
| **light** (default) | [Nodepod](https://github.com/R1ck404/Nodepod) | Node.js 22 APIs in Web Workers, npm/npx, a bash-compatible JS shell | Fast boot, works without special headers |
| **full** | [BrowserPod](https://browserpod.io) | Wasm Linux kernel: real bash, git, Node.js + npm, Wasm-compiled Rust CLIs | Heavier, needs COOP/COEP and an API key |

```
aether-mux/
├── packages/
│   ├── core/            # Runtime contract, wterm terminal, OPFS + AES-GCM persistence, session
│   ├── runtime-node/    # light profile adapter (Nodepod)
│   └── runtime-full/    # full profile adapter (BrowserPod)
├── app/                 # Vite + vanilla TS SPA, profile selector, PWA shell
├── package.json         # npm workspaces
└── tsconfig.json
```

## Run it

Requires Node ≥ 22.6.

```bash
npm install
npm run dev        # http://localhost:5173, light profile
npm run build      # typecheck + production build into app/dist
npm run preview    # serve the build with the production CSP
npm test           # core unit tests (tar, crypto envelope, TTL, secrets)
```

**Light profile.** Starts by default. Try `node -v`, `npm init -y && npm i is-odd`, or the **Run demo** button, which writes `hello.js` via `Runtime.writeFile` and runs it via `Runtime.exec` with streamed output.

**Full profile.** Pick *full · BrowserPod* in the selector, or open `/?profile=full`. On first use you're asked for a BrowserPod API key (free for personal/open-source use at console.browserpod.io). It's stored encrypted, like snapshots. For private deployments you can bake one in with `VITE_BROWSERPOD_API_KEY=… npm run build`. That puts the key in the JS bundle, so never do this for a public site.

The choice is saved in `localStorage` (the only plaintext preference), and `?profile=` overrides it.

### Deploying

`app/dist` is static. For the full profile, and for Nodepod's synchronous `child_process` and threaded Wasm paths, the host must send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`app/public/_headers` already does this for Netlify and Cloudflare Pages. On hosts that can't set headers (e.g. GitHub Pages), the light profile still works in Nodepod's reduced mode and the full profile shows an explanatory error.

## Architecture

`core` defines one contract (`packages/core/src/types.ts`):

```ts
interface Runtime {
  readonly profile: "light" | "full";
  readonly capabilities: RuntimeCapabilities;
  boot(): Promise<void>;
  attachTerminal(io: TerminalIO): Promise<Disposable>;   // interactive shell
  exec(cmd, args, opts?): Promise<ExecResult>;            // one-shot process
  writeFile(path, data): Promise<void>;
  readFile(path): Promise<Uint8Array>;
  exportWorkspace(): Promise<Uint8Array>;                // ustar archive
  importWorkspace(tar: Uint8Array): Promise<void>;
  dispose(): Promise<void>;
}
```

- **Loading.** The app maps each profile to `() => import("@aether-mux/runtime-…")`. Vite emits each as its own chunk, so the full profile costs nothing until it's selected. The adapters lazy-import their engines in the same way.
- **Terminal.** `core/terminal.ts` wraps `@wterm/dom` and outlives runtimes. The session hands each runtime a *scoped* view (`scopeTerminal`), and disposing that view drops every subscription the runtime made, so a leaky adapter can't keep reading keystrokes after a switch.
  - *light:* Nodepod's `createTerminal` already provides the line editor, history, tab completion and a persistent shell (cwd/env survive between commands). It expects an xterm.js object, so `runtime-node/src/xterm-shim.ts` implements the dozen xterm methods it uses on top of wterm. No xterm.js ships.
  - *full:* `createCustomTerminal({ onOutput })` pipes guest output to wterm, and keystrokes go to `Terminal.write`. `/bin/bash --login -i` restarts if it exits.
- **Workspace portability.** Snapshots hold a POSIX tar of `/home/user` (excluding `node_modules`, `.npm`, `.cache`). BrowserPod produces it with the guest's `tar`, and Nodepod's virtual FS is walked into it by `core/tar.ts`. Because both sides speak tar, switching profiles carries your files across.
- **Session.** `core/session.ts` runs boot, switch, snapshot and restore one at a time. If a switch fails (no API key, no isolation), the exported workspace is kept in memory and imported into whatever boots next, which is the light fallback.

## Security model

The goal is that nothing leaves the device unless you run a command that sends it, and nothing sensitive sits on disk in plaintext.

- **No telemetry, no backend.** The app makes no analytics, error-reporting or phone-home requests. Network traffic comes only from guest commands (npm, git, curl) and from the runtime engines loading (BrowserPod's engine comes from `rt.browserpod.io`; Nodepod may fetch esbuild-wasm from jsDelivr).
- **Egress allow-list.** Production builds inject a CSP whose `connect-src` limits where the page *and every guest process* can connect: the npm registry, GitHub, esm.sh/unpkg/jsDelivr, `*.browserpod.io` and `console.neon.tech`. Add hosts at build time with `AETHER_CSP_CONNECT="https://api.example.com"`. `'unsafe-eval'` is unavoidable because both runtimes compile guest JS at run time.
- **Encrypted snapshots in OPFS.** Each snapshot is gzipped, then sealed with **AES-256-GCM** (fresh 96-bit IV per write) and written to the Origin Private File System. OPFS is origin-scoped and not visible in the OS file manager.
  - Envelope: `"AMX1" | header | IV | ciphertext+tag`. The header (`createdAt`, compression flag, purpose) is readable without the key so expired files can be deleted, but it is bound as GCM *additional authenticated data*. Editing it to extend the TTL, or swapping a secret file in as a snapshot, makes decryption fail.
- **Key handling.** A random AES key is generated with `extractable: false` and stored as a `CryptoKey` in IndexedDB (OPFS can't hold one). Page code can use it but can never read its bytes. `PassphraseKeyProvider` (PBKDF2-SHA-256, 600k iterations) is included for builds that want a key that never touches disk.
- **30-day TTL.** Checked at startup and on every listing using the file-name timestamp, and again on load against the *authenticated* header, so renaming a file can't revive it. Timestamps more than a day in the future are treated as tampering. Anything expired, corrupt or undecryptable is deleted, not kept. Up to 10 snapshots are retained.
- **Secrets.** The BrowserPod API key is encrypted the same way, under a hashed file name. The secret's name sits inside the ciphertext so files can't be swapped between secrets.
- **Crypto-shredding.** **Wipe** destroys the key *first*, then deletes OPFS data, runtime caches and preferences. Anything that survives the deletes is unreadable.
- **Runtime-side persistence is turned off:**
  - BrowserPod is booted without `storageKey`, because with one it persists its disk to IndexedDB in plaintext.
  - Nodepod is booted with `enableSnapshotCache: false` and `packageStore: "memory"` (opt in with `cachePackages: true` if you accept plaintext package caches).
- **Other hardening.** OSC 52 clipboard writes from guest programs are ignored. `Referrer-Policy: no-referrer`; `base-uri`, `form-action` and `object-src` are all locked down.

### What this does not protect against

- **Runtime isolation.** Neither runtime is a hardened sandbox against the page. Guest code runs in your origin's workers and, CSP aside, has the same reach as the app. Don't run untrusted code next to secrets you care about.
- **A compromised origin or browser.** XSS on the deployment origin or a malicious extension can use the non-extractable key while the page is open. Encryption at rest protects against disk/profile theft and other origins, not against code running in yours.
- **Nodepod's transform cache.** Nodepod always writes a module-transform cache (`nodepod-transforms` in IndexedDB) with no option to disable it, and it can contain transformed user source. The light runtime deletes it at the start of each page's first boot, when no other tab is using it, so plaintext is bounded to one live session but not eliminated.
- **The full profile's engine** is proprietary code loaded from `rt.browserpod.io`, and its outbound traffic goes through BrowserPod's relay. Its own telemetry behaviour is outside this app's control.

## Profile limitations

| | light (Nodepod) | full (BrowserPod) |
|---|---|---|
| Shell | bash-*compatible* interpreter in JS (pipes, redirects, `$(())`, `&&`, globbing) | real GNU bash |
| git | ✗ | ✓ |
| Native/Wasm binaries | ✗ (JS-only packages; packages with native add-ons fail) | Wasm-compiled Linux userland and Rust CLIs; native npm add-ons still need Wasm builds (`esbuild-wasm`, `@rollup/wasm-node`, …) |
| Terminal resize → guest | ✓ | ✗ (BrowserPod's custom terminal has no resize call) |
| Exit codes from `exec` | ✓ | ✗ (`Process` is opaque; workspace import/export checks success in-band) |
| `dispose()` frees memory | ✓ | ✗ (no teardown API). Switching *away* from full saves an encrypted snapshot and reloads the page |
| Network | browser `fetch` + CORS; Nodepod's allow-list | BrowserPod relay with its own domain allow-list |
| Needs COOP/COEP | no (recommended) | yes |
| Transfer size (gzip) | ≈ 1.8 MB (≈ 80 KB shell + Nodepod 1.11 library and worker) | ≈ 80 KB shell + engine and disk image streamed from browserpod.io |

> **Size note.** The ~600 KB figure in the original brief predates Nodepod 1.11. Most of the light profile's weight is Nodepod's library chunk (≈ 1.1 MB gz) and its process worker (≈ 450 KB gz), and both load only when the light runtime boots.

**Neon CLI (`npx neonctl`)** is a pure Node.js CLI, so it works on the **light** profile as far as installing and running goes. Its API calls to `console.neon.tech` are browser `fetch`es, though: they're subject to CORS and the CSP allow-list, and `neonctl auth`'s localhost OAuth callback can't work in a browser. Use `--api-key` / `NEON_API_KEY` instead.

**Codex CLI** is distributed as a native Rust binary inside its npm package, so it can't run on **light**. On **full**, BrowserPod lists Codex among the Rust CLIs that run unmodified, which makes it the only viable path. It still needs network access to the OpenAI API through BrowserPod's egress allow-list and an API key you supply. Expect slower startup than native.

General rule: if a tool is pure JS, use light. If it needs bash semantics, git, or ships a binary, use full.

## Licensing of dependencies

- **Nodepod** is source-available under MIT + Commons Clause, which forbids selling a product whose value derives substantially from it. Check its license before shipping commercially.
- **BrowserPod** is proprietary: free for personal and open-source use, commercial use requires a plan.
- **wterm** is Apache-2.0.
