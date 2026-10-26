import { dialog, type BrowserWindow } from "electron";
import { m } from "../paraglide/messages.js";
import { checkFolder, type RememberedFolders } from "./folder-access.ts";

type Locale = "en" | "de";

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
}) => {
  const parent = () => input.window() ?? undefined;
  const show = (options: Electron.MessageBoxOptions) => {
    const window = parent();
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  };
  return {
    async folder({ path, reason }: { path?: string; reason?: string }) {
      const locale = await input.locale();
      if (path) {
        const checked = await checkFolder(path, input.appData);
        if ("refused" in checked) return checked;
        if (await input.remembered.has(checked.path)) return { hostPath: checked.path };
        const detail = m.computer_folder_detail({}, { locale });
        const answer = await show({
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
        });
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
    async agent() {
      const locale = await input.locale();
      const answer = await show({
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
      });
      return answer.response === 1;
    },
  };
};
