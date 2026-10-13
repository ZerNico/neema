import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import type { ImageFamily } from "@chat/model-client/image-families";
import { testImageModel } from "~/modules/images/server/functions.ts";
import { toastError } from "~/ui/error-toast.ts";

export type ImageModelTestOutcome = Awaited<ReturnType<typeof testImageModel>>;

/**
 * One small image from adding or editing an image model. A result belongs to
 * the model key and family it tested, so changing either clears it.
 */
export function useImageModelTest(providerId: string) {
  const [tested, setTested] = useState<{
    key: string;
    result: ImageModelTestOutcome;
  } | null>(null);
  const mutation = useMutation({
    mutationFn: ({ modelKey, imageFamily }: { modelKey: string; imageFamily: ImageFamily }) =>
      testImageModel({ data: { providerId, modelKey, imageFamily } }).then((result) => ({
        key: `${imageFamily}:${modelKey}`,
        result,
      })),
    onSuccess: setTested,
    onError: (error) => toastError("Could not test the image model.", error),
  });
  return {
    run: (modelKey: string, imageFamily: ImageFamily) => mutation.mutate({ modelKey, imageFamily }),
    pending: mutation.isPending,
    resultFor: (modelKey: string | undefined, imageFamily: ImageFamily | null) =>
      tested && tested.key === `${imageFamily}:${modelKey}` ? tested.result : null,
    clear: () => setTested(null),
  };
}
