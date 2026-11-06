import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/ui/primitives/alert-dialog";
import { ConfirmContext, type ConfirmFn, type ConfirmOptions } from "./confirm-context.ts";
import { m } from "~/paraglide/messages.js";

/**
 * Promise-based confirmation dialog:
 *
 *   const confirm = useConfirm()
 *   if (await confirm({ title: "Delete model?" })) { ... }
 *
 * Resolves true on confirm, false on cancel or dismiss. A new confirmation
 * dismisses the previous one as false. Built on AlertDialog: outside clicks
 * don't dismiss, only Escape or an answer.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((answer: boolean) => void) | null>(null);

  const confirm: ConfirmFn = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      // A confirm opened while another is pending dismisses the previous one.
      resolveRef.current?.(false);
      resolveRef.current = resolve;
      setOptions(opts);
    });
  }, []);

  const settle = useCallback((answer: boolean) => {
    resolveRef.current?.(answer);
    resolveRef.current = null;
    setOptions(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={options !== null} onOpenChange={(open) => !open && settle(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{options?.title}</AlertDialogTitle>
            {options?.description ? (
              <AlertDialogDescription>{options.description}</AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{options?.cancelLabel ?? m.common_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              variant={(options?.destructive ?? true) ? "destructive" : "default"}
              onClick={() => settle(true)}
            >
              {options?.confirmLabel ?? m.ui_confirm_default()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}
