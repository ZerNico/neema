import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";

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
// provider; concurrent calls queue naturally since the promise gates the flow.
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
      <Dialog open={options !== null} onOpenChange={(open) => !open && settle(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{options?.title}</DialogTitle>
            {options?.description ? (
              <DialogDescription>{options.description}</DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => settle(false)}>
              {options?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={(options?.destructive ?? true) ? "destructive" : "default"}
              onClick={() => settle(true)}
            >
              {options?.confirmLabel ?? "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used within a ConfirmProvider");
  return confirm;
}
