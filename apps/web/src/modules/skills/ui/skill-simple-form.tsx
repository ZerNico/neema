import { useId } from "react";
import {
  readSkillDocument,
  toSkillName,
  writeSkillDocument,
  type SkillDocument,
  type SkillFile,
  type SkillFinding,
} from "../package.ts";
import { Field, FieldDescription, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";
import { Textarea } from "~/ui/primitives/textarea";

/** Whether the form can show this skill; one without readable frontmatter is edited as files. */
export const canEditSimply = (files: readonly SkillFile[]) => {
  const root = files.find((file) => file.path === "SKILL.md");
  return !!root && readSkillDocument(root.content) !== null;
};

const findingFor = (findings: readonly SkillFinding[], key: string) =>
  findings
    .filter((finding) => finding.severity === "error" && finding.message.startsWith(key))
    .map(() => ({
      message:
        key === "name"
          ? "Use lowercase words joined by hyphens, up to 64 characters."
          : "Say when to use this skill, in up to 1,024 characters.",
    }));

/**
 * SKILL.md as a form: name, when to use it, whether the model may pick it on its
 * own, and the instructions. Every edit is written back into the same file, so
 * the Files view and saving see exactly what this form shows.
 */
export function SkillSimpleForm({
  files,
  findings,
  onChange,
  autoFocus = false,
}: {
  files: SkillFile[];
  findings: readonly SkillFinding[];
  /** Absent while saving a new skill, which locks the form. */
  onChange?: ((files: SkillFile[]) => void) | undefined;
  autoFocus?: boolean;
}) {
  const id = useId();
  const root = files.find((file) => file.path === "SKILL.md")!;
  const document = readSkillDocument(root.content)!;
  const update = (patch: Partial<SkillDocument>) =>
    onChange?.(
      files.map((file) =>
        file === root
          ? { ...file, content: writeSkillDocument(root.content, { ...document, ...patch }) }
          : file,
      ),
    );
  const others = files.length - 1;
  const locked = !onChange;
  return (
    <div className="flex flex-col gap-5">
      <Field>
        <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
        <Input
          id={`${id}-name`}
          value={document.name}
          disabled={locked}
          autoFocus={autoFocus}
          placeholder="contract-review"
          onChange={(event) => update({ name: toSkillName(event.target.value) })}
          onBlur={() => update({ name: document.name.replace(/^-+|-+$/gu, "") })}
        />
        <FieldError errors={findingFor(findings, "name")} />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-description`}>When to use it</FieldLabel>
        <Textarea
          id={`${id}-description`}
          value={document.description}
          disabled={locked}
          rows={2}
          placeholder="When someone asks to review a contract or spot risky clauses."
          onChange={(event) => update({ description: event.target.value })}
        />
        <FieldError errors={findingFor(findings, "description")} />
      </Field>
      <Field orientation="horizontal">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <FieldLabel htmlFor={`${id}-automatic`}>Use it automatically</FieldLabel>
          <FieldDescription>
            When off, it’s only used when someone picks it in a chat.
          </FieldDescription>
        </div>
        <Switch
          id={`${id}-automatic`}
          checked={!document.manualOnly}
          disabled={locked}
          onCheckedChange={(checked) => update({ manualOnly: !checked })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-body`}>Instructions</FieldLabel>
        <Textarea
          id={`${id}-body`}
          value={document.body}
          disabled={locked}
          rows={16}
          onChange={(event) => update({ body: event.target.value })}
        />
        {others > 0 ? (
          <FieldDescription>
            This skill also has {others === 1 ? "1 other file" : `${others} other files`}; they’re
            under Files.
          </FieldDescription>
        ) : null}
      </Field>
    </div>
  );
}
