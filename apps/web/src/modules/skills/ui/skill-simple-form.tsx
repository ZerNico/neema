import { useId } from "react";
import {
  readSkillDocument,
  toSkillName,
  writeSkillDocument,
  type SkillDocument,
  type SkillFile,
  type SkillFinding,
  type SkillTextFile,
} from "../package.ts";
import { Field, FieldDescription, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";
import { Textarea } from "~/ui/primitives/textarea";

import { m } from "~/paraglide/messages.js";

const findingFor = (findings: readonly SkillFinding[], key: "name" | "description") =>
  findings
    .filter((finding) => finding.severity === "error" && finding.code === key)
    .map(() => ({
      message: key === "name" ? m.skills_form_name_hint() : m.skills_form_description_hint(),
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
  // Only shown when canEditSimply holds: SKILL.md is text with readable frontmatter.
  const root = files.find((file) => file.path === "SKILL.md") as SkillTextFile;
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
        <FieldLabel htmlFor={`${id}-name`}>{m.common_name()}</FieldLabel>
        <Input
          id={`${id}-name`}
          value={document.name}
          disabled={locked}
          autoFocus={autoFocus}
          // oxlint-disable-next-line i18n/no-literal-text -- a skill name is a slug, the same in every language
          placeholder="contract-review"
          onChange={(event) => update({ name: toSkillName(event.target.value) })}
          onBlur={() => update({ name: document.name.replace(/^-+|-+$/gu, "") })}
        />
        <FieldError errors={findingFor(findings, "name")} />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-description`}>{m.skills_form_when()}</FieldLabel>
        <Textarea
          id={`${id}-description`}
          value={document.description}
          disabled={locked}
          rows={2}
          placeholder={m.skills_form_when_placeholder()}
          onChange={(event) => update({ description: event.target.value })}
        />
        <FieldError errors={findingFor(findings, "description")} />
      </Field>
      <Field orientation="horizontal">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <FieldLabel htmlFor={`${id}-automatic`}>{m.skills_form_automatic()}</FieldLabel>
          <FieldDescription>{m.skills_form_automatic_description()}</FieldDescription>
        </div>
        <Switch
          id={`${id}-automatic`}
          checked={!document.manualOnly}
          disabled={locked}
          onCheckedChange={(checked) => update({ manualOnly: !checked })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-body`}>{m.skills_form_instructions()}</FieldLabel>
        <Textarea
          id={`${id}-body`}
          value={document.body}
          disabled={locked}
          rows={16}
          onChange={(event) => update({ body: event.target.value })}
        />
        {others > 0 ? (
          <FieldDescription>{m.skills_form_more_files({ count: others })}</FieldDescription>
        ) : null}
      </Field>
    </div>
  );
}
