/**
 * The ring a focusable surface takes when it is not a Button, which carries its
 * own. Nine places had spelled this out, one of them resetting the outline under
 * `focus-visible` rather than always, which is how a treatment starts to drift.
 */
export const focusRingClassName = "outline-none focus-visible:ring-3 focus-visible:ring-ring/30";
