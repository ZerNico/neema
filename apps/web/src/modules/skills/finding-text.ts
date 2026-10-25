import { m } from "~/paraglide/messages.js";
import type { Locale } from "~/paraglide/runtime.js";
import { SKILL_LIMITS, type SkillFinding } from "./package.ts";

/**
 * A finding in `locale`. The package check is shared by the page and the
 * server and its findings are stored, so it records a code and the page words
 * it here; a finding without one shows its own English words.
 */
export function findingText(finding: SkillFinding, locale: Locale): string {
  const options = { locale };
  switch (finding.code) {
    case "path":
      return m.skills_finding_path({}, options);
    case "not_text":
      return m.skills_finding_not_text({}, options);
    case "file_count":
      return m.skills_finding_file_count({}, options);
    case "duplicate_path":
      return m.skills_finding_duplicate_path({}, options);
    case "root_binary":
      return m.skills_finding_root_binary({}, options);
    case "too_large":
      return m.skills_finding_too_large({}, options);
    case "surrogate":
      return m.skills_finding_surrogate({}, options);
    case "parent_collides":
      return m.skills_finding_parent_collides({}, options);
    case "expanded_too_large":
      return m.skills_finding_expanded_too_large({}, options);
    case "no_frontmatter":
      return m.skills_finding_no_frontmatter({}, options);
    case "yaml_aliases":
      return m.skills_finding_yaml_aliases({}, options);
    case "not_mapping":
      return m.skills_finding_not_mapping({}, options);
    case "name":
      return m.skills_finding_name({}, options);
    case "description":
      return m.skills_finding_description({}, options);
    case "manual_flag":
      return m.skills_finding_manual_flag({}, options);
    case "unknown_key":
      return m.skills_finding_unknown_key({ key: finding.detail ?? "" }, options);
    case "shell":
      return m.skills_finding_shell({}, options);
    case "unreadable":
      return m.skills_finding_unreadable({}, options);
    case "archive_files":
      return m.skills_finding_archive_files({ count: SKILL_LIMITS.files }, options);
    case "archive_root":
      return m.skills_finding_archive_root({}, options);
    case "export_missing":
      return m.skills_finding_export_missing({ path: finding.path }, options);
    default:
      return finding.message;
  }
}

/** Every finding on its own line, prefixed with its file, as a refusal reads. */
export const findingsText = (findings: readonly SkillFinding[], locale: Locale) =>
  findings.map((finding) => `${finding.path}: ${findingText(finding, locale)}`).join("\n");
