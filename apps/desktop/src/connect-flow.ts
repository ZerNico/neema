import { toOrigin } from "./config.ts";

/**
 * `declined` is the person keeping their current server when asked; the
 * chooser stays open and usable. It is not a failure, so it carries no message.
 */
export type ConnectOutcome =
  | { readonly ok: true; readonly declined?: true }
  | { readonly ok: false; readonly message: string };

export interface ConnectHost {
  /** True while a developer pinned the server; the stored choice is then never touched. */
  fixedServer(): boolean;
  hasMain(): boolean;
  hasWork(): boolean;
  currentOrigin(): string | null;
  confirmSwitch(): Promise<boolean>;
  disposeWork(): Promise<void>;
  writeConfig(origin: string): Promise<void>;
  chooser(): { focus(): void; destroy(): void } | null;
  openConnect(current: string | null): void;
  openMain(origin: string): void;
  closeMain(): void;
}

/**
 * Reopening the server chooser and acting on its answer. Every entry (menu,
 * recovery page, site) can only ask for the chooser; the address is typed
 * there. Local work belongs to the server that started it, so switching
 * disposes it, after the person agrees.
 */
export const makeConnectFlow = (host: ConnectHost) => {
  let switching: Promise<ConnectOutcome> | undefined;

  const openChooser = (): Promise<ConnectOutcome> => {
    if (host.fixedServer())
      return Promise.resolve({
        ok: false,
        message: "The server is fixed by CHAT_DESKTOP_SERVER.",
      });
    const open = host.chooser();
    if (open) {
      open.focus();
      return Promise.resolve({ ok: true });
    }
    if (switching) return switching;
    switching = (async () => {
      if (host.hasMain() && host.hasWork()) {
        // Declining is the person's own answer, not a refusal to report.
        if (!(await host.confirmSwitch())) return { ok: true, declined: true } as const;
        await host.disposeWork();
      }
      host.openConnect(host.currentOrigin());
      return { ok: true } as const;
    })().finally(() => {
      switching = undefined;
    });
    return switching;
  };

  const connect = async (candidate: unknown): Promise<ConnectOutcome> => {
    if (host.fixedServer())
      return { ok: false, message: "The server is fixed by CHAT_DESKTOP_SERVER." };
    const origin = typeof candidate === "string" ? toOrigin(candidate) : null;
    if (origin === null) return { ok: false, message: "That does not look like a server address." };
    if (host.hasWork()) {
      if (!(await host.confirmSwitch())) return { ok: true, declined: true };
    }
    await host.writeConfig(origin);
    if (host.hasMain() || host.hasWork()) {
      await host.disposeWork();
      if (host.hasMain()) host.closeMain();
    }
    host.openMain(origin);
    host.chooser()?.destroy();
    return { ok: true };
  };

  return { openChooser, connect };
};
