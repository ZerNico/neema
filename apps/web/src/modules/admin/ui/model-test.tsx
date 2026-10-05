import { MODEL_FORMAT_LABELS } from "./model-settings-labels.ts";
import type { ModelTest } from "./use-model-test.ts";
import { cn } from "~/ui/utils";

export function ModelTestResult({ test }: { test: ModelTest | null }) {
  if (!test) return null;
  const { result, switchedTo } = test;
  const works = switchedTo ? `Works on ${MODEL_FORMAT_LABELS[switchedTo]}` : "Works";
  return (
    <p role="status" className={cn("text-xs", result.ok ? "text-success" : "text-destructive")}>
      {result.ok
        ? result.reply
          ? `${works}: replied “${result.reply}” in ${result.latencyMs}ms.`
          : `${works}: answered in ${result.latencyMs}ms.`
        : `Didn’t work: ${result.error}`}
    </p>
  );
}
