/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional BrowserPod key baked in at build time (private deployments only: it becomes public in the bundle). */
  readonly VITE_BROWSERPOD_API_KEY?: string;
}
