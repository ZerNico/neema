interface RecoveryWindow {
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  loadFile(file: string): Promise<void>;
  webContents: {
    on(
      event: "did-fail-load",
      listener: (
        event: unknown,
        code: number,
        description: string,
        url: string,
        isMainFrame: boolean,
      ) => void,
    ): unknown;
  };
}

const isAborted = (cause: unknown) =>
  cause !== null &&
  typeof cause === "object" &&
  (("errno" in cause && cause.errno === -3) || ("code" in cause && cause.code === "ERR_ABORTED"));

/**
 * Only a failed initial document gets replaced. An established Work renderer may
 * own background executions, even when a later navigation or request fails.
 */
export const attachLoadRecovery = (
  window: RecoveryWindow,
  origin: string,
  recoveryFile: string,
  reportError: (cause: unknown) => void,
) => {
  let attempt = 0;
  let loading = false;
  let healthy = false;
  let recovering = false;

  const showRecovery = async () => {
    if (healthy || recovering || window.isDestroyed()) return;
    attempt += 1;
    loading = false;
    recovering = true;
    try {
      await window.loadFile(recoveryFile);
    } catch (cause) {
      if (!isAborted(cause) && !window.isDestroyed()) reportError(cause);
    }
  };

  window.webContents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    if (!loading || !isMainFrame || code === -3) return;
    try {
      if (new URL(url).origin !== origin) return;
    } catch {
      return;
    }
    void showRecovery();
  });

  return {
    retry: async () => {
      if (loading || healthy || window.isDestroyed()) return;
      const current = ++attempt;
      loading = true;
      recovering = false;
      try {
        await window.loadURL(origin);
        if (current === attempt) healthy = true;
      } catch (cause) {
        if (current === attempt && !isAborted(cause)) await showRecovery();
      } finally {
        if (current === attempt) loading = false;
      }
    },
  };
};
