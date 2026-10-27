import { dialog, type BrowserWindow } from "electron";
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
}) => {
  const parent = () => input.window() ?? undefined;
  /** Closed by `signal`, as if cancelled, when the call is stopped meanwhile. */
  const show = (options: Electron.MessageBoxOptions, signal?: AbortSignal) => {
    const window = parent();
    const withSignal = signal ? { ...options, signal } : options;
    return window ? dialog.showMessageBox(window, withSignal) : dialog.showMessageBox(withSignal);
  };
  return {
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
