Create a complete single-repository skeleton for a browser-based terminal called "AETHER Mux".

The project must support two runtime profiles that share a common core:

1. **light** — uses Nodepod (~600 KB). Extremely lightweight, fast boot, supports pure Node.js CLIs (npm install, npx, Neon CLI, scaffolding tools, etc.). No native binaries.

2. **full** — uses BrowserPod. Heavier, more powerful. Supports Node.js + bash + git + better compatibility with complex tools (including better Codex paths).

Both profiles must share:
- Terminal UI (wterm / @wterm/dom)
- Persistence layer (OPFS + AES-GCM encryption via Web Crypto)
- 30-day TTL on stored snapshots
- Profile switching with dynamic import (light loads by default)
- Extreme local-first security (no telemetry, origin-private storage, encrypted snapshots)
- Portable across modern browsers including iOS Safari (static SPA + optional PWA)




Root structure:

aether-mux/ ├── packages/ │ ├── core/ # Shared nucleus (terminal, persistence, session, types) │ ├── runtime-node/ # Light profile (Nodepod) │ └── runtime-full/ # Full profile (BrowserPod) ├── app/ # Vite + vanilla TypeScript SPA ├── package.json ├── README.md └── tsconfig.json
Define a clear `Runtime` interface in core that both runtimes implement. The app loads the chosen runtime via dynamic import.



- Default to the **light** profile.
- Allow switching to **full** at runtime (or via persisted preference).
- Persistence must encrypt snapshots before writing to OPFS and decrypt on restore.
- Implement a simple TTL check (30 days) that discards old snapshots.
- Terminal must connect cleanly to the active runtime’s process I/O.
- Use only modern browser APIs (OPFS, Web Crypto, Workers where needed).
- Keep the light profile as small and fast as possible.
- Include a minimal but working example of booting, spawning a command, and snapshot/restore.
- Add clear comments only where the “why” is not obvious.
- Provide a short README explaining how to run both profiles and the security model.



Generate the full file tree with complete, working code for:

1. Core types and Runtime interface
2. Persistence module (OPFS + encryption + TTL)
3. Terminal integration wrapper (wterm)
4. Light runtime adapter (Nodepod)
5. Full runtime adapter (BrowserPod stub or real integration where feasible)
6. App entry point with profile selector
7. package.json with correct dependencies
8. Minimal Vite config
9. README.md

Focus on correctness, security, and maintainability. Prefer composition over duplication. Make the light path production-usable out of the box.



- No Next.js, no heavy UI frameworks (vanilla TS or minimal Preact if absolutely needed).
- No server required for core functionality.
- All sensitive data must stay encrypted at rest in OPFS.
- Document any known limitations of Nodepod vs BrowserPod regarding CLIs (especially Codex vs Neon).