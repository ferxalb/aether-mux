import "./styles.css";
import {
  clearPreferences,
  DeviceKeyProvider,
  errorMessage,
  isProfileId,
  MemoryBlobStore,
  OpfsBlobStore,
  opfsSupported,
  requestPersistentStorage,
  resolveProfile,
  saveProfile,
  SecretStore,
  Session,
  SnapshotStore,
  Terminal,
  type BlobStore,
  type ProfileId,
  type RuntimeLoader,
  type SecretProvider,
  type SessionStatus,
} from "@aether-mux/core";

const WORKDIR = "/home/user";
/** Snapshot id to restore after a reload-based profile switch. Not sensitive: it's a random file name. */
const RESTORE_AFTER_RELOAD = "aether-mux:restore-after-reload";

/**
 * Each profile is its own dynamic import, so Vite emits it as a separate
 * chunk and the full profile costs nothing until someone selects it.
 */
const loaders: Record<ProfileId, RuntimeLoader> = {
  light: async () => {
    const mod = await import("@aether-mux/runtime-node");
    return {
      createRuntime: (o) => mod.createRuntime({ ...o, workerUrl: new URL("__worker__.js", document.baseURI).href }),
    };
  },
  full: () => import("@aether-mux/runtime-full"),
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  profile: $<HTMLSelectElement>("profile"),
  snapshot: $<HTMLButtonElement>("snapshot"),
  snapshots: $<HTMLSelectElement>("snapshots"),
  restore: $<HTMLButtonElement>("restore"),
  demo: $<HTMLButtonElement>("demo"),
  wipe: $<HTMLButtonElement>("wipe"),
  badges: $<HTMLSpanElement>("badges"),
  status: $<HTMLElement>("status"),
  terminal: $<HTMLElement>("terminal"),
  dialog: $<HTMLDialogElement>("secret-dialog"),
  dialogText: $<HTMLParagraphElement>("secret-description"),
  dialogInput: $<HTMLInputElement>("secret-input"),
};

async function openStorage(path: string[]): Promise<{ store: BlobStore; persistent: boolean }> {
  if (opfsSupported()) {
    try {
      // getDirectory() rejects in some private-browsing modes even though it exists.
      await navigator.storage.getDirectory();
      return { store: new OpfsBlobStore(path), persistent: true };
    } catch {
      /* fall through */
    }
  }
  return { store: new MemoryBlobStore(), persistent: false };
}

function askSecret(description: string): Promise<string | null> {
  ui.dialogText.textContent = description;
  ui.dialogInput.value = "";
  ui.dialog.returnValue = "";
  ui.dialog.showModal();
  return new Promise((resolve) => {
    ui.dialog.addEventListener(
      "close",
      () => {
        const value = ui.dialogInput.value.trim();
        ui.dialogInput.value = "";
        resolve(ui.dialog.returnValue === "ok" && value ? value : null);
      },
      { once: true },
    );
  });
}

function renderBadges(session: Session, persistent: boolean): void {
  const caps = session.runtime?.capabilities;
  const badges: Array<[string, "on" | "warn" | ""]> = [
    [crossOriginIsolated ? "isolated" : "not isolated", crossOriginIsolated ? "on" : "warn"],
    [persistent ? "OPFS · AES-GCM" : "memory only", persistent ? "on" : "warn"],
  ];
  if (caps) {
    badges.push(["bash", caps.realBash ? "on" : ""], ["git", caps.git ? "on" : ""], ["wasm bins", caps.nativeBinaries ? "on" : ""]);
  }
  ui.badges.replaceChildren(
    ...badges.map(([text, tone]) => {
      const el = document.createElement("span");
      el.className = `badge ${tone}`;
      el.textContent = text;
      return el;
    }),
  );
}

function formatSnapshot(createdAt: number, expiresAt: number): string {
  const days = Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000));
  return `${new Date(createdAt).toLocaleString()} · ${days}d left`;
}

async function main(): Promise<void> {
  const keys = new DeviceKeyProvider();
  const snapshotStorage = await openStorage(["aether-mux", "snapshots"]);
  const secretStorage = await openStorage(["aether-mux", "secrets"]);
  const snapshots = new SnapshotStore({ blobs: snapshotStorage.store, keys });
  const secretStore = new SecretStore(secretStorage.store, keys);

  const secrets: SecretProvider = {
    async get(name, description) {
      // A build-time key is convenient for self-hosting; it ends up in the JS bundle, so only use it for private deployments.
      const fromEnv = name === "browserpod.apiKey" ? import.meta.env.VITE_BROWSERPOD_API_KEY : undefined;
      if (typeof fromEnv === "string" && fromEnv) return fromEnv;
      const stored = await secretStore.get(name);
      if (stored) return stored;
      const entered = await askSecret(description);
      if (entered) await secretStore.set(name, entered);
      return entered;
    },
  };

  const terminal = await Terminal.create(ui.terminal, {
    scrollbackLines: 5000,
    onTitle: (t) => (document.title = t ? `${t} · AETHER Mux` : "AETHER Mux"),
  });

  const controls = [ui.profile, ui.snapshot, ui.snapshots, ui.restore, ui.demo];
  const onStatus = (s: SessionStatus) => {
    ui.status.textContent = s.message;
    ui.status.dataset.state = s.state;
    const busy = s.state === "booting" || s.state === "busy";
    for (const c of controls) c.disabled = busy;
    if (s.profile) ui.profile.value = s.profile;
    renderBadges(session, snapshotStorage.persistent);
  };

  const session = new Session({ terminal, loaders, snapshots, secrets, workdir: WORKDIR, onStatus });

  const refreshSnapshots = async () => {
    const list = await snapshots.list();
    ui.snapshots.replaceChildren(
      ...(list.length
        ? list.map((s) => new Option(formatSnapshot(s.createdAt, s.expiresAt), s.id))
        : [new Option("no snapshots", "")]),
    );
    ui.restore.disabled = list.length === 0;
  };

  // TTL sweep on every start, before anything can read an expired snapshot.
  const purged = await snapshots.purgeExpired();
  if (purged) terminal.notice(`Deleted ${purged} snapshot(s) older than 30 days.`);
  if (!snapshotStorage.persistent) terminal.notice("OPFS unavailable (private mode?). Snapshots will not survive a reload.", "warn");
  await refreshSnapshots();

  // ---- profile selection ---------------------------------------------------
  const startProfile = async (profile: ProfileId) => {
    try {
      await session.start(profile);
    } catch {
      if (profile !== "light") {
        terminal.notice("Falling back to the light profile.", "warn");
        await session.start("light").catch(() => {});
      }
    }
  };

  ui.profile.addEventListener("change", async () => {
    const next = ui.profile.value;
    if (!isProfileId(next)) return;
    saveProfile(next);
    const current = session.runtime;
    try {
      if (current && !current.capabilities.releasesOnDispose) {
        // The current engine can't free its workers in-page, so hand the
        // workspace over through an encrypted snapshot and a reload.
        const snap = await session.snapshot("profile switch");
        sessionStorage.setItem(RESTORE_AFTER_RELOAD, snap.id);
        location.reload();
        return;
      }
      await session.switchProfile(next);
    } catch (err) {
      // Boot failures are already reported by the session; only surface other errors.
      if (session.status.state !== "error") terminal.notice(errorMessage(err), "error");
      if (!session.runtime) {
        terminal.notice("Falling back to the light profile.", "warn");
        await session.start("light").catch(() => {});
      }
    }
  });

  // ---- snapshot / restore --------------------------------------------------
  ui.snapshot.addEventListener("click", async () => {
    try {
      await requestPersistentStorage();
      const s = await session.snapshot();
      terminal.notice(`Snapshot saved (${(s.sizeBytes / 1024).toFixed(1)} KiB encrypted, expires ${new Date(s.expiresAt).toLocaleDateString()}).`);
    } catch (err) {
      terminal.notice(`Snapshot failed: ${errorMessage(err)}`, "error");
    }
    await refreshSnapshots();
  });

  ui.restore.addEventListener("click", async () => {
    const id = ui.snapshots.value;
    if (!id) return;
    try {
      await session.restore(id);
      terminal.notice("Workspace restored.");
    } catch (err) {
      terminal.notice(errorMessage(err), "error");
    }
    await refreshSnapshots();
  });

  // ---- demo: write a file, spawn a process, stream its output -------------
  ui.demo.addEventListener("click", async () => {
    const rt = session.runtime;
    if (!rt) return;
    const script = [
      `const os = require("os");`,
      `console.log("hello from " + process.release.name + " " + process.version + " on " + os.platform());`,
      `console.log("cwd:", process.cwd());`,
      `require("fs").writeFileSync("demo-output.txt", "written at " + new Date().toISOString() + "\\n");`,
      `console.log("wrote demo-output.txt — take a snapshot, edit it, then restore");`,
    ].join("\n");
    try {
      await rt.writeFile(`${rt.workdir}/hello.js`, script);
      terminal.notice(`${rt.profile}: node hello.js`);
      const { exitCode } = await rt.exec("node", ["hello.js"], {
        onOutput: (chunk) => terminal.write(chunk.replace(/(?<!\r)\n/g, "\r\n")),
      });
      terminal.notice(exitCode === null ? "done" : `exit code ${exitCode}`);
    } catch (err) {
      terminal.notice(`demo failed: ${errorMessage(err)}`, "error");
    }
  });

  // ---- wipe ------------------------------------------------------------------
  ui.wipe.addEventListener("click", async () => {
    if (!confirm("Destroy the encryption key and delete every snapshot, secret and cache on this device?")) return;
    await session.stop();
    // Destroying the key first is what makes this safe: any byte that
    // survives the deletes below is undecryptable.
    await keys.destroy();
    await Promise.allSettled([snapshots.removeAll(), secretStorage.store.removeAll()]);
    try {
      await (await navigator.storage.getDirectory()).removeEntry("aether-mux", { recursive: true });
    } catch {
      /* already gone */
    }
    // Runtime caches (Nodepod uses IndexedDB). A delete is "blocked" while a
    // connection is still open; it then completes as the reload closes them,
    // so don't wait on it, just bound the wait for the ones that can finish now.
    const dbs = (await indexedDB.databases?.().catch(() => [])) ?? [];
    const deletions = dbs
      .filter((d) => d.name)
      .map(
        (d) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(d.name!);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          }),
      );
    await Promise.race([Promise.allSettled(deletions), new Promise((r) => setTimeout(r, 2000))]);
    clearPreferences();
    sessionStorage.clear();
    location.replace(location.pathname);
  });

  // ---- boot -----------------------------------------------------------------
  await startProfile(resolveProfile());

  const pending = sessionStorage.getItem(RESTORE_AFTER_RELOAD);
  if (pending) {
    sessionStorage.removeItem(RESTORE_AFTER_RELOAD);
    try {
      await session.restore(pending);
      terminal.notice("Workspace carried over from the previous profile.");
    } catch (err) {
      terminal.notice(`Could not carry workspace over: ${errorMessage(err)}`, "warn");
    }
  }

  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
  }
}

main().catch((err) => {
  ui.status.textContent = `Fatal: ${errorMessage(err)}`;
  ui.status.dataset.state = "error";
  console.error(err);
});
