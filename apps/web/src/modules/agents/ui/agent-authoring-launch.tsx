import { BubbleChatIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { agentAuthoringRequest } from "../authoring.ts";
import { Button, buttonVariants } from "~/ui/primitives/button";
import { DropdownMenuItem } from "~/ui/primitives/dropdown-menu";
import { m } from "~/paraglide/messages.js";

/** Creation through chat; editing an existing agent is the menu item below. */
export function AgentAuthoringLaunchButton({ disabled = false }: { disabled?: boolean }) {
  const content = (
    <>
      <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} data-icon="inline-start" />
      {m.agents_launch_create_with_chat()}
    </>
  );
  if (disabled)
    return (
      <Button size="sm" variant="outline" disabled>
        {content}
      </Button>
    );
  return (
    <Link
      to="/"
      search={{}}
      state={{ chatPrefill: agentAuthoringRequest() }}
      className={buttonVariants({ size: "sm", variant: "outline" })}
    >
      {content}
    </Link>
  );
}

export function AgentAuthoringLaunchMenuItem({ agentId }: { agentId: string }) {
  return (
    <DropdownMenuItem
      render={<Link to="/" search={{}} state={{ chatPrefill: agentAuthoringRequest(agentId) }} />}
    >
      <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} />
      {m.agents_launch_edit_with_chat()}
    </DropdownMenuItem>
  );
}
