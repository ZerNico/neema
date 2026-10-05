import { isBinarySkillFile, readSkillDocument, type SkillFile } from "../package.ts";

/** Whether the form can show this skill; one without readable frontmatter is edited as files. */
export const canEditSimply = (files: readonly SkillFile[]) => {
  const root = files.find((file) => file.path === "SKILL.md");
  return !!root && !isBinarySkillFile(root) && readSkillDocument(root.content) !== null;
};
