export const makeLifecycle = (host: {
  hide(): void;
  hasWork(): boolean;
  confirmQuit(): Promise<boolean>;
  dispose(): Promise<void>;
  quit(): void;
  reportError(cause: unknown): void;
}) => {
  let quitting = false;
  let pending: Promise<void> | undefined;
  return {
    close(event: { preventDefault(): void }) {
      if (quitting) return;
      event.preventDefault();
      host.hide();
    },
    beforeQuit(event: { preventDefault(): void }, options: { confirm?: boolean } = {}) {
      if (quitting) return;
      event.preventDefault();
      if (pending) return pending;
      pending = (async () => {
        if (options.confirm !== false && host.hasWork() && !(await host.confirmQuit())) return;
        await host.dispose();
        quitting = true;
        host.quit();
      })()
        .catch(host.reportError)
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
};
