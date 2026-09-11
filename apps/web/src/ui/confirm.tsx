import { createContext, useCallback, useContext, useRef, useState } from "react";
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

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (default true — deletes are the common case). */
  destructive?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

// Promise-based confirmation dialog:
//
//   const confirm = useConfirm()
//   if (await confirm({ title: "Delete model?" })) { ... }
//
// Resolves true on confirm, false on cancel/dismiss. One dialog instance per
// provider; opening another confirmation dismisses the previous one as false.
// Built on AlertDialog so the browser gets role="alertdialog" and outside
// clicks don't dismiss — the user has to pick an answer (Escape still cancels).
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      // A confirm opened while another is pending dismisses the previous one.
      resolveRef.current?.(false);
      resolveRef.current = resolve;
      setOptions(opts);
    });
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    resolveRef.current?.(confirmed);
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
            <AlertDialogCancel>{options?.cancelLabel ?? "Cancel"}</AlertDialogCancel>
            <AlertDialogAction
              variant={(options?.destructive ?? true) ? "destructive" : "default"}
              onClick={() => settle(true)}
            >
              {options?.confirmLabel ?? "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used within a ConfirmProvider");
  return confirm;
}
