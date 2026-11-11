import type { Disposable, TerminalIO } from "@aether-mux/core";

/**
 * Nodepod's `createTerminal` instantiates whatever `Terminal` class it is given
 * and only uses this subset of the xterm.js API: open, write, writeln, clear,
 * focus, dispose, loadAddon, onData, onResize, cols, rows, options. We satisfy
 * exactly that over our wterm-backed TerminalIO so the light profile doesn't
 * have to ship xterm.js at all.
 */
export interface XtermShim extends Disposable {
  readonly Terminal: new (options?: Record<string, unknown>) => unknown;
  /** Passed to NodepodTerminal.attach(); the real DOM is already owned by wterm. */
  readonly mountPoint: HTMLElement;
}

export function xtermShimFor(io: TerminalIO): XtermShim {
  const owned = new Set<Disposable>();
  const track = (d: Disposable): Disposable => {
    owned.add(d);
    return {
      dispose: () => {
        owned.delete(d);
        d.dispose();
      },
    };
  };

  class ShimTerminal {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options };
    }
    get cols(): number {
      return io.cols;
    }
    get rows(): number {
      return io.rows;
    }
    open(_el: HTMLElement): void {}
    loadAddon(_addon: unknown): void {}
    write(data: string | Uint8Array): void {
      io.write(data);
    }
    writeln(data: string): void {
      io.write(`${data}\r\n`);
    }
    clear(): void {
      io.clear();
    }
    focus(): void {
      io.focus();
    }
    onData(listener: (data: string) => void): Disposable {
      return track(io.onData(listener));
    }
    onResize(listener: (size: { cols: number; rows: number }) => void): Disposable {
      return track(io.onResize((cols, rows) => listener({ cols, rows })));
    }
    // Called by NodepodTerminal.detach(). It must not tear down the shared
    // wterm screen, only our subscriptions.
    dispose(): void {
      for (const d of owned) d.dispose();
      owned.clear();
    }
  }

  return {
    Terminal: ShimTerminal,
    mountPoint: document.createElement("div"),
    dispose: () => {
      for (const d of owned) d.dispose();
      owned.clear();
    },
  };
}
