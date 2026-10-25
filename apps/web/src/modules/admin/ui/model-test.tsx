import { MODEL_FORMAT_LABELS } from "./model-settings-labels.ts";
import type { ModelTest } from "./use-model-test.ts";
import { cn } from "~/ui/utils";
import { m } from "~/paraglide/messages.js";

export function ModelTestResult({ test }: { test: ModelTest | null }) {
  if (!test) return null;
  const { result, switchedTo } = test;
  const format = switchedTo ? MODEL_FORMAT_LABELS[switchedTo] : null;
  return (
    <p role="status" className={cn("text-xs", result.ok ? "text-success" : "text-destructive")}>
      {!result.ok
        ? m.admin_test_failed({ error: result.error })
        : result.reply
          ? format
            ? m.admin_test_replied_on({ format, reply: result.reply, ms: result.latencyMs })
            : m.admin_test_replied({ reply: result.reply, ms: result.latencyMs })
          : format
            ? m.admin_test_answered_on({ format, ms: result.latencyMs })
            : m.admin_test_answered({ ms: result.latencyMs })}
    </p>
  );
}
