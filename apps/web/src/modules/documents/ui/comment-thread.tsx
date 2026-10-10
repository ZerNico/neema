import {
  AiChat02Icon,
  File01Icon,
  ArrowUp01Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, useState } from "react";
import { ChatTextarea, type TextareaMentions } from "~/modules/chat/ui/chat-textarea.tsx";
import { inlineTagClassName } from "~/ui/inline-tag.ts";
import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { initials } from "~/ui/initials.ts";
import { Avatar, AvatarFallback } from "~/ui/primitives/avatar";
import { Button } from "~/ui/primitives/button";
import { InputGroup, InputGroupAddon, InputGroupButton } from "~/ui/primitives/input-group";
import { Spinner } from "~/ui/primitives/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";
import type { DocumentComment } from "../schema.ts";
import { shorten, type ThreadActions } from "./comment-actions.ts";

/** How the assistant is named in a comment that asks it. */
const ASSISTANT_MENTION = "@Assistant";
const ASSISTANT_PATTERN = /(^|\s)@Assistant(?=\s|$)/u;
const ASSISTANT_SOURCE: TextareaMentions = {
  items: [
    {
      id: "assistant",
      label: "Assistant",
      description: "Answers in this thread",
      search: "assistant ai",
    },
  ],
  onSelect: () => undefined,
  icon: () => <HugeiconsIcon icon={AiChat02Icon} strokeWidth={2} className="size-3.5" />,
};

/**
 * Where a comment or reply is written, on the chat composer's own field:
 * Enter sends, Shift+Enter breaks the line, and naming `@Assistant`, typed
 * or picked from the list "@" opens, also sends it to the assistant.
 */
export function CommentInput({
  placeholder,
  canAsk,
  autoFocus,
  askByDefault = false,
  onSubmit,
}: {
  placeholder: string;
  canAsk: boolean;
  autoFocus?: boolean;
  /** Starts with the assistant named, as a new comment in a chat does. */
  askByDefault?: boolean;
  onSubmit: (body: string, toAssistant: boolean) => Promise<void>;
}) {
  const [body, setBody] = useState(canAsk && askByDefault ? `${ASSISTANT_MENTION} ` : "");
  const [sending, setSending] = useState(false);
  const asking = canAsk && ASSISTANT_PATTERN.test(body);
  const send = () => {
    const text = body.trim();
    if (!text || text === ASSISTANT_MENTION || sending) return;
    setSending(true);
    void onSubmit(text, asking)
      .then(() => setBody(""))
      .finally(() => setSending(false));
  };
  const toggleAssistant = () =>
    setBody((current) =>
      ASSISTANT_PATTERN.test(current)
        ? current.replace(new RegExp(ASSISTANT_PATTERN, "gu"), "$1").replace(/^\s+/u, "")
        : `${ASSISTANT_MENTION} ${current}`,
    );
  return (
    <InputGroup>
      <div className="w-full min-w-0 text-left">
        <ChatTextarea
          value={body}
          onValueChange={setBody}
          onSubmit={send}
          ariaLabel={placeholder}
          placeholder={canAsk ? `${placeholder}, or @ the assistant` : placeholder}
          autoFocus={autoFocus ?? false}
          disabled={sending}
          className="px-3 pt-2.5"
          integrations={canAsk ? ASSISTANT_SOURCE : undefined}
        />
      </div>
      <InputGroupAddon align="block-end">
        {canAsk ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <InputGroupButton
                  size="icon-xs"
                  variant={asking ? "secondary" : "ghost"}
                  aria-pressed={asking}
                  aria-label="Ask the assistant"
                  onClick={toggleAssistant}
                />
              }
            >
              <HugeiconsIcon icon={AiChat02Icon} strokeWidth={2} />
            </TooltipTrigger>
            <TooltipContent>
              {asking ? "Don’t ask the assistant" : "Ask the assistant"}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <InputGroupButton
          size="icon-xs"
          variant="default"
          className="ml-auto"
          aria-label="Send"
          disabled={!body.trim() || body.trim() === ASSISTANT_MENTION || sending}
          onClick={send}
        >
          {sending ? <Spinner /> : <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

/** A comment's words, with the assistant drawn as the tag it was written as. */
function CommentBody({ text }: { text: string }) {
  // Each part keyed by where it starts in the text, which no two share.
  const parts = text
    .split(/(@Assistant)(?=\s|$)/u)
    .reduce<{ part: string; start: number }[]>((all, part) => {
      const last = all.at(-1);
      return [...all, { part, start: last ? last.start + last.part.length : 0 }];
    }, [])
    // A comment opening with the mention splits off an empty piece at the same offset.
    .filter(({ part }) => part !== "");
  return (
    <p className="text-sm break-words whitespace-pre-wrap">
      {parts.map(({ part, start }) =>
        part === ASSISTANT_MENTION ? (
          <span key={start} className={inlineTagClassName("field")}>
            <HugeiconsIcon icon={AiChat02Icon} strokeWidth={2} className="size-3.5" />
            Assistant
          </span>
        ) : (
          <Fragment key={start}>{part}</Fragment>
        ),
      )}
    </p>
  );
}

function IconAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: typeof Delete02Icon;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button size="icon-xs" variant="ghost" aria-label={label} onClick={onClick} />}
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Comment({
  comment,
  own,
  actions,
  isRoot,
}: {
  comment: DocumentComment;
  own: boolean;
  actions: ThreadActions | null;
  isRoot: boolean;
}) {
  const name = comment.byAssistant
    ? "Assistant"
    : comment.fromFile
      ? comment.fromFile.name || "Note"
      : (comment.author?.name ?? "Someone");
  return (
    <div className="group/comment flex gap-2.5">
      <Avatar size="sm">
        <AvatarFallback>
          {comment.byAssistant ? (
            <HugeiconsIcon icon={AiChat02Icon} strokeWidth={2} className="size-3.5" />
          ) : comment.fromFile ? (
            <HugeiconsIcon icon={File01Icon} strokeWidth={2} className="size-3.5" />
          ) : (
            initials(name)
          )}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex h-6 items-center gap-2 text-xs">
          <span className="truncate font-medium">{name}</span>
          {comment.fromFile ? (
            <span className="text-muted-foreground shrink-0">from Excel</span>
          ) : null}
          <span className="text-muted-foreground shrink-0">
            {relativeAgeLabel(comment.createdAt)}
          </span>
          {own && actions ? (
            <span className="ml-auto opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100">
              <IconAction
                label={isRoot ? "Delete thread" : "Delete reply"}
                icon={Delete02Icon}
                onClick={() => void actions.remove(comment.id)}
              />
            </span>
          ) : null}
        </div>
        <CommentBody text={comment.body} />
      </div>
    </div>
  );
}

/**
 * One thread: what it is on, its comments, whether the assistant is still on
 * it, and, while open, a reply. `actions` is null for a reader who may not
 * comment.
 */
export function CommentThread({
  root,
  replies,
  anchored,
  me,
  actions,
  expanded,
  onQuoteClick,
}: {
  root: DocumentComment;
  replies: DocumentComment[];
  anchored: boolean;
  me: string | null;
  actions: ThreadActions | null;
  /** Shows the reply box; a list shows it only for the thread being read. */
  expanded: boolean;
  onQuoteClick?: (() => void) | undefined;
}) {
  const all = [root, ...replies];
  const waiting = all.some((each) => each.toAssistant && !each.answered);
  const quote = (
    <span className="line-clamp-2 text-left">
      {anchored ? null : <span className="font-medium">Text removed · </span>}
      {shorten(root.quote ?? "", 160)}
    </span>
  );
  return (
    <div className={cn("flex flex-col gap-3", root.resolvedAt && "opacity-70")}>
      <div className="flex items-start gap-2">
        {onQuoteClick && anchored ? (
          <button
            type="button"
            className="border-warning text-muted-foreground hover:text-foreground min-w-0 flex-1 border-l-2 pl-2 text-xs"
            onClick={onQuoteClick}
          >
            {quote}
          </button>
        ) : (
          <div className="border-warning text-muted-foreground min-w-0 flex-1 border-l-2 pl-2 text-xs">
            {quote}
          </div>
        )}
        {actions ? (
          <IconAction
            label={root.resolvedAt ? "Reopen" : "Resolve"}
            icon={CheckmarkCircle02Icon}
            onClick={() => void actions.resolve(root.id, !root.resolvedAt)}
          />
        ) : null}
      </div>
      {/* A long thread scrolls inside the card, newest last, with the reply field kept in view. */}
      <div
        ref={(element) => {
          if (element) element.scrollTop = element.scrollHeight;
        }}
        className="-mr-2 flex max-h-[min(22rem,45vh)] flex-col gap-3 overflow-y-auto pr-2"
      >
        {all.map((comment) => (
          <Comment
            key={comment.id}
            comment={comment}
            own={comment.byAssistant || comment.fromFile !== null || comment.author?.id === me}
            actions={actions}
            isRoot={comment.id === root.id}
          />
        ))}
      </div>
      {waiting ? (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Spinner />
          The assistant is working on it
        </p>
      ) : null}
      {expanded && actions && !root.resolvedAt ? (
        <CommentInput
          placeholder="Reply"
          canAsk={actions.canAsk}
          onSubmit={(body, toAssistant) =>
            actions.reply(root.id, root.quote ?? "", body, toAssistant)
          }
        />
      ) : null}
    </div>
  );
}
