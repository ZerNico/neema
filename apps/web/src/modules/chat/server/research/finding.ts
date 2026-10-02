/** Longest finding kept; one plain sentence fits well under it. */
const FINDING_CHARS = 240;
// Models often bold the label, so Markdown around it is part of the line.
const FINDING_LINE = /^[ \t]*[*_]*Finding:[*_]*[ \t]*(.*)$/im;

/**
 * Splits the reader's one-line finding off a task report. The report stays the
 * model's evidence; the finding is what the person sees under the topic while
 * the run works, so it carries no citation markers or Markdown.
 */
export function splitFinding(report: string): { report: string; finding?: string } {
  const match = FINDING_LINE.exec(report);
  if (!match) return { report };
  const rest = (report.slice(0, match.index) + report.slice(match.index + match[0].length)).trim();
  const finding = (match[1] ?? "")
    .replaceAll(/\[\^\d+\]/g, "")
    .replaceAll(/[*_`#>]/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (!finding || /^none\.?$/i.test(finding)) return { report: rest };
  return {
    report: rest,
    finding: finding.length > FINDING_CHARS ? `${finding.slice(0, FINDING_CHARS - 1)}…` : finding,
  };
}
