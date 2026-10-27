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
import { m } from "~/paraglide/messages.js";

interface ChatChoice {
  /** Null is "start one on the first run". */
  id: string | null;
  title: string;
}

const modes = () =>
  [
    { value: "new", label: m.schedules_chat_mode_new() },
    { value: "same", label: m.schedules_chat_mode_same() },
  ] as const;

const firstRun = (): ChatChoice => ({ id: null, title: m.schedules_chat_first_run() });

/**
 * Where a schedule's runs land: a fresh chat each time, or one chat every
 * time. That chat is either one picked here or one the first run creates.
 */
export const ScheduleChatField = withForm({
  defaultValues: EMPTY_SCHEDULE_DRAFT,
  render: function ScheduleChatField({ form }) {
    const chatMode = useStore(form.store, (state) => state.values.chatMode);
    const chatId = useStore(form.store, (state) => state.values.chatId);
    const MODES = modes();
    const FIRST_RUN = firstRun();
    const recent = useInfiniteQuery({
      ...conversationsInfiniteQuery(""),
      enabled: chatMode === "same",
    });
    const chats: ChatChoice[] = (recent.data?.pages ?? [])
      .flatMap((page) => page.conversations)
      .map((conversation) => ({
        id: conversation.id,
        title: conversation.title ?? m.schedules_chat_untitled(),
      }));
    const selected = chatId
      ? (chats.find((chat) => chat.id === chatId) ?? {
          id: chatId,
          title: m.schedules_chat_chosen(),
        })
      : FIRST_RUN;
    return (
      <div className="flex flex-col gap-3">
        <FieldLabel>{m.schedules_chat_label()}</FieldLabel>
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
            <SelectTrigger aria-label={m.schedules_chat_label()} className="w-52">
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
                aria-label={m.schedules_chat_which()}
                render={<Button variant="outline" className="max-w-72 justify-between" />}
              >
                <span className="truncate">{selected.title}</span>
              </ComboboxTrigger>
              <ComboboxContent align="start" className="w-80">
                <ComboboxInput placeholder={m.schedules_chat_search()} showTrigger={false} />
                <ComboboxEmpty>{m.schedules_chat_empty()}</ComboboxEmpty>
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
            {m.schedules_chat_own_agent()}{" "}
            <Link
              to="/chat/$conversationId"
              params={{ conversationId: chatId }}
              className="underline underline-offset-2"
            >
              {m.schedules_chat_open()}
            </Link>
          </FieldDescription>
        ) : null}
      </div>
    );
  },
});
