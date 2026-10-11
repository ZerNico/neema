import { ArrowDown01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState } from "react";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "~/ui/disclosure.tsx";
import {
  disclosureBodyRailClassName,
  disclosureChevronMotionClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure-classes.ts";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { Field, FieldDescription, FieldLabel } from "~/ui/primitives/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "~/ui/primitives/input-group";
import { cn } from "~/ui/utils";
import type { OAuthSetup } from "../manifest.ts";

/**
 * The redirect URI to copy, then the manifest's steps for registering the app.
 * Open until the integration has a client, since that is when they are read.
 */
export function OAuthSetupGuide({
  id,
  setup,
  redirectUri,
  config,
  configured,
}: {
  id: string;
  setup: OAuthSetup;
  redirectUri: string;
  config: Readonly<Record<string, string>>;
  configured: boolean;
}) {
  const [open, setOpen] = useState(!configured);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const consoleUrl = setup.console?.url(config) ?? null;
  return (
    <Field>
      <FieldLabel htmlFor={id}>Redirect URI</FieldLabel>
      <InputGroup>
        <InputGroupInput id={id} readOnly value={redirectUri} />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            aria-label={copied ? "Copied" : "Copy redirect URI"}
            size="icon-xs"
            onClick={() => {
              void navigator.clipboard.writeText(redirectUri).then(() => {
                clearTimeout(copyTimer.current);
                setCopied(true);
                copyTimer.current = setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={2} />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {/* One step with nowhere to go reads as a note, not as instructions to open. */}
      {!setup.console && setup.steps.length === 1 ? (
        <FieldDescription>{setup.steps[0]!.text}</FieldDescription>
      ) : (
        <Disclosure open={open} onOpenChange={setOpen}>
          <DisclosureTrigger className={cn(disclosureTriggerClassName, focusRingClassName)}>
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              strokeWidth={2}
              className={cn(disclosureChevronMotionClassName, "size-4", open && "rotate-180")}
            />
            How to set up OAuth
          </DisclosureTrigger>
          <DisclosureContent>
            <ol className={cn(disclosureBodyRailClassName, "list-decimal space-y-2 pl-8")}>
              {setup.console ? (
                <li>
                  Open the{" "}
                  {consoleUrl ? (
                    <a
                      href={consoleUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-foreground underline underline-offset-4"
                    >
                      {setup.console.label}
                    </a>
                  ) : (
                    setup.console.label
                  )}
                  .
                </li>
              ) : null}
              {setup.steps.map((step) => (
                <li key={step.text}>
                  {step.text}
                  {step.values ? (
                    <span className="mt-1.5 flex flex-wrap gap-1.5">
                      {step.values.map((value) => (
                        <code
                          key={value}
                          className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground select-all"
                        >
                          {value}
                        </code>
                      ))}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </DisclosureContent>
        </Disclosure>
      )}
    </Field>
  );
}
