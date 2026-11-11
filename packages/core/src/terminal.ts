import { WTerm } from "@wterm/dom";
import "@wterm/dom/css";
import type { Disposable, TerminalIO } from "./types.ts";

export interface TerminalOptions {
  /** CSS theme class from @wterm/dom (e.g. "theme-monokai"). */
  readonly theme?: string;
  readonly scrollbackLines?: number;
  readonly onTitle?: (title: string) => void;
}

class Emitter<A extends unknown[]> {
  readonly #listeners = new Set<(...args: A) => void>();
  on(listener: (...args: A) => void): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => void this.#listeners.delete(listener) };
  }
  emit(...args: A): void {
    for (const l of [...this.#listeners]) {
      try {
        l(...args);
      } catch (err) {
        console.error("[aether-mux] terminal listener failed", err);
      }
    }
  }
}

/**
 * wterm-backed terminal that outlives runtimes: switching profile re-attaches
 * the same screen to a new guest instead of rebuilding the DOM.
 */
export class Terminal implements TerminalIO, Disposable {
  readonly #wterm: WTerm;
  readonly #data = new Emitter<[string]>();
  readonly #resize = new Emitter<[number, number]>();

  readonly element: HTMLElement;

  private constructor(element: HTMLElement, options: TerminalOptions) {
    this.element = element;
    if (options.theme) element.classList.add(options.theme);
    this.#wterm = new WTerm(element, {
      autoResize: true,
      cursorBlink: true,
      ...(options.scrollbackLines ? { scrollbackLines: options.scrollbackLines } : {}),
      // Supplying onData also disables wterm's default local echo; echo is the guest's job.
      onData: (data) => this.#data.emit(data),
      onResize: (cols, rows) => this.#resize.emit(cols, rows),
      ...(options.onTitle ? { onTitle: options.onTitle } : {}),
      // Apps may ask to write the clipboard via OSC 52; we deliberately ignore
      // it so guest code can't silently plant clipboard content.
      onClipboardWrite: () => {},
    });
  }

  static async create(element: HTMLElement, options: TerminalOptions = {}): Promise<Terminal> {
    const t = new Terminal(element, options);
    await t.#wterm.init();
    return t;
  }

  get cols(): number {
    return this.#wterm.cols;
  }
  get rows(): number {
    return this.#wterm.rows;
  }

  write(data: string | Uint8Array): void {
    this.#wterm.write(data);
  }

  /** Host-originated messages (status, errors), visually distinct from guest output. */
  notice(message: string, tone: "info" | "warn" | "error" = "info"): void {
    const color = tone === "error" ? "31" : tone === "warn" ? "33" : "36";
    this.write(`\r\n\x1b[${color}m[aether] ${message.replace(/\n/g, "\r\n")}\x1b[0m\r\n`);
  }

  onData(listener: (data: string) => void): Disposable {
    return this.#data.on(listener);
  }

  onResize(listener: (cols: number, rows: number) => void): Disposable {
    return this.#resize.on(listener);
  }

  focus(): void {
    this.#wterm.focus();
  }

  clear(): void {
    this.write("\x1b[H\x1b[2J\x1b[3J");
  }

  dispose(): void {
    this.#wterm.destroy();
  }
}

/**
 * A view of a TerminalIO that tracks every subscription made through it, so a
 * runtime that forgets to unsubscribe can't keep receiving keystrokes after
 * the session has moved on to another runtime.
 */
export function scopeTerminal(io: TerminalIO): TerminalIO & Disposable {
  const subs = new Set<Disposable>();
  let disposed = false;
  const track = (d: Disposable): Disposable => {
    if (disposed) {
      d.dispose();
      return d;
    }
    subs.add(d);
    return {
      dispose: () => {
        subs.delete(d);
        d.dispose();
      },
    };
  };
  return {
    get cols() {
      return io.cols;
    },
    get rows() {
      return io.rows;
    },
    write: (data) => {
      if (!disposed) io.write(data);
    },
    onData: (l) => track(io.onData(l)),
    onResize: (l) => track(io.onResize(l)),
    focus: () => io.focus(),
    clear: () => {
      if (!disposed) io.clear();
    },
    dispose: () => {
      disposed = true;
      for (const d of subs) d.dispose();
      subs.clear();
    },
  };
}
