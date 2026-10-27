import { app, dialog, type BrowserWindow } from "electron";
import type { SharedAppDriver } from "../app-use/host.ts";
import { m } from "../paraglide/messages.js";
import { basename } from "node:path";
import { checkFolder, type RememberedFolders } from "./folder-access.ts";
import { addKey, addKeyCommand, agentKeyCount, defaultKey } from "./ssh-keys.ts";

type Locale = "en" | "de";

/** Whether the chat may use the agent, and whether that agent holds a key to sign in with. */
export type AgentAnswer = "allowed" | "allowed-empty" | "declined";

/**
 * Native questions to the person at this machine. A page cannot draw, fake or answer them, which
 * is why the machine's own resources are asked for here (docs/internals/desktop.md). What the
 * model reads back stays English, like every tool result.
 */
export const computerDialogs = (input: {
  window: () => BrowserWindow | null;
  /** The person's language: their choice in the page, else the system's. */
  locale: () => Promise<Locale>;
  appData: string;
  remembered: RememberedFolders;
  /** The agent chats are relayed to, asked how many keys it holds. */
  agentSocket: () => string | null;
  /** neema's own app bundle, which a privacy list takes when dragged onto it. */
  appBundle: string;
}) => {
  const parent = () => input.window() ?? undefined;
  /** Closed by `signal`, as if cancelled, when the call is stopped meanwhile. */
  const show = (options: Electron.MessageBoxOptions, signal?: AbortSignal) => {
    const window = parent();
    const withSignal = signal ? { ...options, signal } : options;
    return window ? dialog.showMessageBox(window, withSignal) : dialog.showMessageBox(withSignal);
  };
  return {
    /** Whether a chat may use an app: here only, or in every chat (docs/internals/app-use.md). */
    async app(target: { name: string }, signal?: AbortSignal): Promise<"chat" | "always" | "deny"> {
      const locale = await input.locale();
      const answer = await show(
        {
          type: "question",
          title: m.computer_app_title({ app: target.name }, { locale }),
          message: m.computer_app_message({ app: target.name }, { locale }),
          detail: m.computer_app_detail({}, { locale }),
          buttons: [
            m.computer_dialog_cancel({}, { locale }),
            m.computer_app_allow_chat({}, { locale }),
            m.computer_app_allow_always({}, { locale }),
          ],
          defaultId: 1,
          cancelId: 0,
        },
        signal,
      );
      return answer.response === 1 ? "chat" : answer.response === 2 ? "always" : "deny";
    },
    /**
     * Leads the person through the grants app use needs, with a panel in System Settings to drag
     * neema into each list: on macOS 26 the system's prompts no longer add a new app to either.
     * Screen Recording counts only after neema reopens, which it offers. Stop closes the panel.
     */
    async appPermissions(driver: SharedAppDriver, signal: AbortSignal) {
      const locale = await input.locale();
      const cancel = () => void driver.call("cancelGuide", {}).catch(() => {});
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const instruction = m.computer_app_guide_instruction({}, { locale });
        const granted = await driver.call("permissions", {});
        if (!granted.accessibility) {
          const { outcome } = await driver.call("guide", {
            permission: "accessibility",
            bundle: input.appBundle,
            title: m.computer_app_guide_accessibility({}, { locale }),
            instruction,
          });
          if (outcome !== "granted") return;
        }
        if (granted.capture) return;
        const { outcome } = await driver.call("guide", {
          permission: "screenRecording",
          bundle: input.appBundle,
          title: m.computer_app_guide_screen({}, { locale }),
          instruction,
        });
        if (outcome !== "granted" || signal.aborted) return;
        const answer = await show(
          {
            type: "question",
            title: m.computer_app_reopen_title({}, { locale }),
            message: m.computer_app_reopen_title({}, { locale }),
            detail: m.computer_app_reopen_detail({}, { locale }),
            buttons: [
              m.computer_app_reopen_later({}, { locale }),
              m.computer_app_reopen_now({}, { locale }),
            ],
            defaultId: 1,
            cancelId: 0,
          },
          signal,
        );
        if (answer.response === 1) {
          app.relaunch();
          app.quit();
        }
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
    async folder({ path, reason }: { path?: string; reason?: string }, signal?: AbortSignal) {
      const locale = await input.locale();
      if (path) {
        const checked = await checkFolder(path, input.appData);
        if ("refused" in checked) return checked;
        if (await input.remembered.has(checked.path)) return { hostPath: checked.path };
        const detail = m.computer_folder_detail({}, { locale });
        const answer = await show(
          {
            type: "question",
            title: m.computer_folder_title({}, { locale }),
            message: m.computer_folder_message({ path: checked.path }, { locale }),
            // The reason is the model's own words, shown as they came.
            detail: reason ? `${reason}\n\n${detail}` : detail,
            buttons: [
              m.computer_dialog_cancel({}, { locale }),
              m.computer_dialog_allow({}, { locale }),
            ],
            defaultId: 1,
            cancelId: 0,
            checkboxLabel: m.computer_folder_remember({}, { locale }),
          },
          signal,
        );
        if (answer.response !== 1) return { refused: "The user declined." };
        if (answer.checkboxChecked) await input.remembered.add(checked.path);
        return { hostPath: checked.path };
      }
      const title = reason ?? m.computer_folder_pick_title({}, { locale });
      const options: Electron.OpenDialogOptions = {
        title,
        message: title,
        buttonLabel: m.computer_folder_pick_button({}, { locale }),
        properties: ["openDirectory", "createDirectory"],
      };
      const window = parent();
      const picked = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      const chosen = picked.filePaths[0];
      if (picked.canceled || !chosen) return { refused: "The user picked no folder." };
      const checked = await checkFolder(chosen, input.appData);
      return "refused" in checked ? checked : { hostPath: checked.path };
    },
    /**
     * Asks to let the chat use the agent, unless it already may. An agent with no keys would
     * make that useless, as with keys only on disk: then it offers to add the default one first,
     * also to a chat already allowed.
     */
    async agent({ allowed }: { allowed: boolean }, signal?: AbortSignal): Promise<AgentAnswer> {
      const locale = await input.locale();
      const socket = input.agentSocket();
      const count = socket ? await agentKeyCount(socket) : null;
      if (count !== 0) {
        if (allowed) return "allowed";
        const answer = await show(
          {
            type: "question",
            title: m.computer_agent_title({}, { locale }),
            message: m.computer_agent_message({}, { locale }),
            detail: m.computer_agent_detail({}, { locale }),
            buttons: [
              m.computer_dialog_cancel({}, { locale }),
              m.computer_dialog_allow({}, { locale }),
            ],
            defaultId: 1,
            cancelId: 0,
          },
          signal,
        );
        return answer.response === 1 ? "allowed" : "declined";
      }
      const key = await defaultKey();
      const answer = await show(
        {
          type: "question",
          title: m.computer_agent_title({}, { locale }),
          message: key
            ? m.computer_agent_empty_message({ key: basename(key) }, { locale })
            : m.computer_agent_empty_no_key({}, { locale }),
          detail: m.computer_agent_detail({}, { locale }),
          buttons: [
            m.computer_dialog_cancel({}, { locale }),
            key ? m.computer_agent_add({}, { locale }) : m.computer_dialog_allow({}, { locale }),
          ],
          defaultId: 1,
          cancelId: 0,
        },
        signal,
      );
      if (answer.response !== 1) return allowed ? "allowed-empty" : "declined";
      if (!key || !socket) return "allowed-empty";
      const prompt = m.computer_agent_passphrase({ key: basename(key) }, { locale });
      if (await addKey(socket, key, prompt)) return "allowed";
      await show({
        type: "warning",
        title: m.computer_agent_add_failed_title({}, { locale }),
        message: m.computer_agent_add_failed_title({}, { locale }),
        detail: m.computer_agent_add_failed_detail({ command: addKeyCommand(key) }, { locale }),
      });
      return "allowed-empty";
    },
  };
};
