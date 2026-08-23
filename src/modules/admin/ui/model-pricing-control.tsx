import { CoinsDollarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { updateModel } from "../server/functions.ts";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";

export type ModelPricing = { input: number; output: number } | null;

// Prices are small ("2.5"), so keep full precision but drop trailing zeros.
const formatPrice = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 4 });

const parsePrice = (raw: string): number | null => {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

/**
 * Per-model price editor on the provider detail page: USD per 1M tokens,
 * used to estimate usage cost when the provider does not report what it
 * billed. Clearing both fields removes the pricing (cost becomes unknown).
 */
export function ModelPricingControl({
  modelId,
  modelName,
  pricing,
}: {
  modelId: string;
  modelName: string;
  pricing: ModelPricing;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");

  const label = pricing
    ? `$${formatPrice(pricing.input)} / $${formatPrice(pricing.output)}`
    : "No pricing";

  const save = useMutation({
    mutationFn: (next: ModelPricing) => updateModel({ data: { modelId, pricing: next } }),
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
  });

  const parsedInput = parsePrice(input);
  const parsedOutput = parsePrice(output);
  const clearing = input.trim() === "" && output.trim() === "";
  const valid = clearing || (parsedInput !== null && parsedOutput !== null);

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="text-muted-foreground h-7 gap-1.5 px-2 text-xs"
        aria-label={`Pricing for ${modelName}: ${label}`}
        onClick={() => {
          setInput(pricing ? String(pricing.input) : "");
          setOutput(pricing ? String(pricing.output) : "");
          setOpen(true);
        }}
      >
        <HugeiconsIcon icon={CoinsDollarIcon} className="size-3.5" />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Pricing — {modelName}</DialogTitle>
            <DialogDescription>
              USD per 1M tokens, used to estimate cost when the provider doesn't report it. Leave
              both empty if unknown.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel>Input $/1M</FieldLabel>
              <Input
                inputMode="decimal"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="2.50"
              />
            </Field>
            <Field>
              <FieldLabel>Output $/1M</FieldLabel>
              <Input
                inputMode="decimal"
                value={output}
                onChange={(e) => setOutput(e.target.value)}
                placeholder="10.00"
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!valid || save.isPending}
              onClick={() =>
                save.mutate(
                  clearing ? null : { input: parsedInput ?? 0, output: parsedOutput ?? 0 },
                )
              }
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
