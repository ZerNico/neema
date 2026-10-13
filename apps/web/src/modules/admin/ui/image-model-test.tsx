import type { ImageModelTestOutcome } from "./use-image-model-test.ts";

export function ImageModelTestResult({ result }: { result: ImageModelTestOutcome | null }) {
  if (!result) return null;
  if (!result.ok)
    return (
      <p role="status" className="text-destructive text-xs">
        Didn’t work: {result.error}
      </p>
    );
  return (
    <div role="status" className="flex items-center gap-3">
      <img src={result.image} alt="Test image" className="size-16 rounded-xl object-cover" />
      <p className="text-success text-xs">Works: made this in {result.latencyMs}ms.</p>
    </div>
  );
}
