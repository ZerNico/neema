import type { LinkSafetyConfig } from "streamdown";
import { LeaveDialog } from "./leave-dialog.tsx";

/** For every `<Streamdown>` that renders links: one question, in the app's design. */
export const LINK_SAFETY: LinkSafetyConfig = {
  enabled: true,
  renderModal: (props) => <LeaveDialog {...props} />,
};
