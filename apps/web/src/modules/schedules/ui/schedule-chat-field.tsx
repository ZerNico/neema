import { useInfiniteQuery } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { conversationsInfiniteQuery } from "~/modules/chat/client/queries.ts";
import { EMPTY_SCHEDULE_DRAFT } from "../draft-schema.ts";
import { withForm } from "~/ui/form/app-form.ts";
import { Button } from "~/ui/primitives/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "~/ui/primitives/combobox";
import { FieldDescription, FieldLabel } from "~/ui/primitives/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";

interface ChatChoice {
  /** Null is "start one on the first run". */
  id: string | null;
  title: string;
}

const MODES = [
  { value: "new", label: "New chat each time" },
  { value: "same", label: "Same chat every time" },
] as const;

const FIRST_RUN: ChatChoice = { id: null, title: "Start one on the first run" };

/**
 * Where a schedule's runs land: a fresh chat each time, or one chat every
 * time. That chat is either one picked here or one the first run creates.
 * Work chats are left out: they need the desktop app, which a run never has.
 */
export const ScheduleChatField = withForm({
  defaultValues: EMPTY_SCHEDULE_DRAFT,
  render: function ScheduleChatField({ form }) {
    const chatMode = useStore(form.store, (state) => state.values.chatMode ?? "new");
    const chatId = useStore(form.store, (state) => state.values.chatId ?? null);
    const recent = useInfiniteQuery({
      ...conversationsInfiniteQuery(""),
      enabled: chatMode === "same",
    });
    const chats: ChatChoice[] = (recent.data?.pages ?? [])
      .flatMap((page) => page.conversations)
      .filter((conversation) => conversation.mode === "chat")
      .map((conversation) => ({ id: conversation.id, title: conversation.title ?? "New chat" }));
    const selected = chatId
      ? (chats.find((chat) => chat.id === chatId) ?? { id: chatId, title: "Chosen chat" })
      : FIRST_RUN;
    return (
      <div className="flex flex-col gap-3">
        <FieldLabel>Chat</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            items={MODES}
            value={chatMode}
            onValueChange={(mode: "new" | "same" | null) => {
              if (!mode) return;
              form.setFieldValue("chatMode", mode);
              if (mode === "new") form.setFieldValue("chatId", null);
            }}
          >
            <SelectTrigger aria-label="Chat" className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((mode) => (
                <SelectItem key={mode.value} value={mode.value}>
                  {mode.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {chatMode === "same" ? (
            <Combobox
              items={[FIRST_RUN, ...chats]}
              value={selected}
              onValueChange={(choice: ChatChoice | null) => {
                if (choice) form.setFieldValue("chatId", choice.id);
              }}
              itemToStringLabel={(choice: ChatChoice) => choice.title}
              isItemEqualToValue={(a: ChatChoice, b: ChatChoice) => a.id === b.id}
              autoHighlight
            >
              <ComboboxTrigger
                aria-label="Which chat"
                render={<Button variant="outline" className="max-w-72 justify-between" />}
              >
                <span className="truncate">{selected.title}</span>
              </ComboboxTrigger>
              <ComboboxContent align="start" className="w-80">
                <ComboboxInput placeholder="Search chats…" showTrigger={false} />
                <ComboboxEmpty>No chats match</ComboboxEmpty>
                <ComboboxList>
                  {(choice: ChatChoice) => (
                    <ComboboxItem key={choice.id ?? "first-run"} value={choice}>
                      <span className="truncate">{choice.title}</span>
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          ) : null}
        </div>
        {chatMode === "same" && chatId ? (
          <FieldDescription>
            Runs use this chat’s own agent.{" "}
            <Link
              to="/chat/$conversationId"
              params={{ conversationId: chatId }}
              className="underline underline-offset-2"
            >
              Open the chat
            </Link>
          </FieldDescription>
        ) : null}
      </div>
    );
  },
});
