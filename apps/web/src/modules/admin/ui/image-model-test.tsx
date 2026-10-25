import type { ImageModelTestOutcome } from "./use-image-model-test.ts";
import { m } from "~/paraglide/messages.js";

export function ImageModelTestResult({ result }: { result: ImageModelTestOutcome | null }) {
  if (!result) return null;
  if (!result.ok)
    return (
      <p role="status" className="text-destructive text-xs">
        {m.admin_test_failed({ error: result.error })}
      </p>
    );
  return (
    <div role="status" className="flex items-center gap-3">
      <img
        src={result.image}
        alt={m.admin_test_image_alt()}
        className="size-16 rounded-xl object-cover"
      />
      <p className="text-success text-xs">{m.admin_test_image_works({ ms: result.latencyMs })}</p>
    </div>
  );
}
