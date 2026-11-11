import { defineConfig, type Connect, type Plugin } from "vite";
import nodepod from "@r1ck404/nodepod/vite";

/**
 * Cross-origin isolation unlocks SharedArrayBuffer: required by BrowserPod,
 * and enables Nodepod's synchronous child_process / threaded-Wasm paths.
 * Static hosts must send the same headers (see public/_headers).
 */
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/**
 * Network egress allow-list for the page and every worker it spawns (guest
 * processes included). Extend at build time with
 * AETHER_CSP_CONNECT="https://api.example.com https://other.example".
 */
const CONNECT_SRC = [
  "'self'",
  // npm installs and Nodepod's default fetch allow-list
  "https://registry.npmjs.org",
  "https://github.com",
  "https://api.github.com",
  "https://codeload.github.com",
  "https://raw.githubusercontent.com",
  "https://objects.githubusercontent.com",
  "https://esm.sh",
  "https://unpkg.com",
  "https://cdn.jsdelivr.net",
  // BrowserPod engine, disk images and network relay (full profile only)
  "https://*.browserpod.io",
  "wss://*.browserpod.io",
  // Neon CLI API
  "https://console.neon.tech",
  ...(process.env.AETHER_CSP_CONNECT ?? "").split(/\s+/).filter(Boolean),
];

const CSP = [
  "default-src 'self'",
  // 'unsafe-eval': both runtimes compile guest JavaScript at run time; there
  // is no way to run user code without it. Remote script hosts are the
  // runtimes' own engines (BrowserPod) and Nodepod's esbuild-wasm build.
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob: https://rt.browserpod.io https://cdn.jsdelivr.net https://esm.sh",
  "worker-src 'self' blob:",
  `connect-src ${CONNECT_SRC.join(" ")}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Inject the CSP as a <meta> in production builds so it works on any static host. */
function contentSecurityPolicy(): Plugin {
  return {
    name: "aether-csp",
    apply: "build",
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" }],
  };
}

/**
 * `server.headers` is not applied to responses that other plugins' middleware
 * finish themselves (Nodepod's /__worker__.js). Under COEP a worker script
 * without these headers is blocked, so set them before any middleware runs.
 */
function isolationHeaders(): Plugin {
  // Block body on purpose: a value returned from configureServer is run as a post-hook.
  const apply = (server: { middlewares: Connect.Server }): void => {
    server.middlewares.use((_req, res, next) => {
      for (const [k, v] of Object.entries(ISOLATION_HEADERS)) res.setHeader(k, v);
      next();
    });
  };
  return { name: "aether-isolation-headers", enforce: "pre", configureServer: apply, configurePreviewServer: apply };
}

export default defineConfig({
  // Relative base so the build can be hosted under any sub-path.
  base: "./",
  plugins: [isolationHeaders(), nodepod(), contentSecurityPolicy()],
  server: { headers: ISOLATION_HEADERS },
  preview: { headers: ISOLATION_HEADERS },
  build: {
    // Top-level await (BrowserPod's loader) and private class fields; Safari 15+.
    target: "es2022",
    sourcemap: false,
  },
  worker: { format: "es" },
  optimizeDeps: {
    // Both locate their worker/engine assets relative to their own module URL,
    // which pre-bundling would break.
    exclude: ["@r1ck404/nodepod", "@leaningtech/browserpod"],
  },
});
