import { createContext, useContext } from "react";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (default true, since deletes are the common case). */
  destructive?: boolean;
  alternativeLabel?: string | undefined;
}

/**
 * With `alternativeLabel`, a second way to go ahead sits beside confirm and
 * answers `"alternative"`.
 */
export interface ConfirmFn {
  (options: ConfirmOptions & { alternativeLabel: string | undefined }): Promise<ConfirmAnswer>;
  (options: ConfirmOptions): Promise<boolean>;
}
export type ConfirmAnswer = boolean | "alternative";

export const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used within a ConfirmProvider");
  return confirm;
}
