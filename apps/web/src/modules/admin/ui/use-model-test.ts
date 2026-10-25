import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { testChatModel } from "../server/functions.ts";
import type { ModelFormat } from "~/modules/providers/model-config.ts";
import { toastError } from "~/ui/error-toast.ts";
import { m } from "~/paraglide/messages.js";

export type ModelTestOutcome = Awaited<ReturnType<typeof testChatModel>>;

export interface ModelTest {
  readonly result: ModelTestOutcome;
  /** The API the model answered on, when the test had to switch to it. */
  readonly switchedTo: ModelFormat | null;
}

/**
 * One short request to a chat model, from adding or editing it. A result
 * belongs to the model key it tested, so picking another model clears it.
 * A model that refused its API and answered on another hands that one to
 * `onSwitch`, so the form shows what will be used.
 */
export function useModelTest(providerId: string, onSwitch?: (format: ModelFormat) => void) {
  const [tested, setTested] = useState<{ modelKey: string; test: ModelTest } | null>(null);
  const mutation = useMutation({
    mutationFn: ({ modelKey, format }: { modelKey: string; format: ModelFormat | null }) =>
      testChatModel({ data: { providerId, modelKey, format } }).then((result) => {
        const used = result.ok ? result.format : undefined;
        return {
          modelKey,
          test: { result, switchedTo: used && format && used !== format ? used : null },
        };
      }),
    onSuccess: (next) => {
      setTested(next);
      if (next.test.switchedTo) onSwitch?.(next.test.switchedTo);
    },
    onError: (error) => toastError(m.admin_test_error(), error),
  });
  return {
    run: (modelKey: string, format: ModelFormat | null) => mutation.mutate({ modelKey, format }),
    pending: mutation.isPending,
    resultFor: (modelKey: string | undefined) =>
      tested && tested.modelKey === modelKey ? tested.test : null,
    clear: () => setTested(null),
  };
}
