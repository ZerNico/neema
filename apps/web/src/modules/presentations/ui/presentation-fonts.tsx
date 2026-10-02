import { Delete02Icon, TextFontIcon, Upload01Icon, Upload04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import * as m from "motion/react-m";
import { useRef } from "react";
import { formatFileSize } from "~/modules/attachments/constants.ts";
import { useConfirm } from "~/ui/confirm.tsx";
import { toastError } from "~/ui/error-toast.ts";
import { useAppReducedMotion } from "~/ui/motion.tsx";
import { ListRow } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Switch } from "~/ui/primitives/switch";
import { useFileDrop } from "~/ui/use-file-drop.ts";
import {
  deletePresentationFont,
  listPresentationFonts,
  setPresentationFontEmbed,
  uploadPresentationFont,
} from "../server/font-functions.ts";

export const presentationFontsQuery = queryOptions({
  queryKey: ["admin", "presentation-fonts"],
  queryFn: () => listPresentationFonts(),
});

type Font = Awaited<ReturnType<typeof listPresentationFonts>>[number];

const styleLabel = (font: Font) =>
  font.bold && font.italic
    ? "Bold italic"
    : font.bold
      ? "Bold"
      : font.italic
        ? "Italic"
        : "Regular";

function FontItem({ font }: { font: Font }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const remove = useMutation({
    mutationFn: () => deletePresentationFont({ data: { id: font.id } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: presentationFontsQuery.queryKey }),
    onError: (error) => toastError("Could not remove the font.", error),
  });
  const embed = useMutation({
    mutationFn: (next: boolean) => setPresentationFontEmbed({ data: { id: font.id, embed: next } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: presentationFontsQuery.queryKey }),
    onError: (error) => toastError("Could not change embedding.", error),
  });
  return (
    <li className="flex min-w-0 items-center gap-2 text-sm">
      <HugeiconsIcon
        icon={TextFontIcon}
        strokeWidth={2}
        className="text-muted-foreground size-4 shrink-0"
        aria-hidden
      />
      <span className="truncate">{font.family}</span>
      <span className="text-muted-foreground truncate text-xs">
        {styleLabel(font)} · {formatFileSize(font.byteSize)}
        {font.embeddable ? "" : " · licence forbids embedding"}
      </span>
      {font.embeddable ? (
        <div className="text-muted-foreground ml-auto flex shrink-0 items-center gap-2 text-xs">
          <span aria-hidden>Embed in decks</span>
          <Switch
            checked={embed.isPending ? embed.variables : font.embed}
            disabled={embed.isPending}
            onCheckedChange={(next) => embed.mutate(next)}
            aria-label={`Embed ${font.family} ${styleLabel(font)} in decks`}
          />
        </div>
      ) : null}
      <PendingButton
        variant="ghost"
        size="icon-sm"
        className={font.embeddable ? undefined : "ml-auto"}
        aria-label={`Remove ${font.family} ${styleLabel(font)}`}
        pending={remove.isPending}
        onClick={() => {
          void confirm({
            title: `Remove “${font.family}” ${styleLabel(font).toLowerCase()}?`,
            description:
              "Previews fall back to a standard font for this style. Decks that use it keep naming it.",
            confirmLabel: "Remove font",
          }).then((confirmed) => {
            if (confirmed) remove.mutate();
          });
        }}
      >
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
      </PendingButton>
    </li>
  );
}

/**
 * The fonts deck previews draw, as a row of the Office files section. A deck
 * only names its fonts, so people opening the file still need them installed.
 */
export function PresentationFontsRow() {
  const fonts = useSuspenseQuery(presentationFontsQuery).data;
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const reduced = useAppReducedMotion();
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      // One at a time, so a rejected file names itself and the rest still land.
      for (const file of files) {
        const data = new FormData();
        data.set("file", file);
        try {
          await uploadPresentationFont({ data });
        } catch (error) {
          toastError(`Could not add the font “${file.name}”.`, error);
        }
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: presentationFontsQuery.queryKey }),
  });
  const add = (files: Iterable<File>) => {
    const list = [...files];
    if (list.length) upload.mutate(list);
  };
  const { dragging, handlers } = useFileDrop({ enabled: !upload.isPending, onDrop: add });
  return (
    // The row is the drop target; the overlay is inert so it never intercepts
    // dragleave or drop.
    <div className="relative" data-drop-zone="fonts" {...handlers}>
      <ListRow className="flex-col items-stretch gap-3">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Fonts</span>
            <span className="text-muted-foreground text-xs">
              Fonts the assistant can use in slides. Drop .ttf or .otf files here, one per style.
            </span>
          </div>
          <input
            ref={input}
            type="file"
            accept=".ttf,.otf,font/ttf,font/otf"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              add(files);
            }}
          />
          <PendingButton
            size="sm"
            variant="outline"
            pending={upload.isPending}
            onClick={() => input.current?.click()}
          >
            <HugeiconsIcon icon={Upload01Icon} strokeWidth={2} />
            Upload
          </PendingButton>
        </div>
        {fonts.length ? (
          <ul className="flex flex-col gap-1" aria-label="Uploaded fonts">
            {fonts.map((font) => (
              <FontItem key={font.id} font={font} />
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-xs">
            None yet. Decks use Calibri, Cambria, Arial, Times New Roman and Courier New
            equivalents.
          </p>
        )}
      </ListRow>
      <m.div
        aria-hidden={!dragging}
        inert
        initial={false}
        animate={{ opacity: dragging ? 1 : 0 }}
        transition={{ duration: reduced ? 0 : 0.12 }}
        className="border-ring/70 bg-background/85 pointer-events-none absolute inset-1 z-10 grid place-items-center rounded-2xl border-2 border-dashed backdrop-blur-[2px]"
      >
        <span className="text-foreground flex items-center gap-2 text-sm font-medium">
          <HugeiconsIcon icon={Upload04Icon} strokeWidth={2} className="size-4" aria-hidden />
          Drop fonts to add them
        </span>
      </m.div>
    </div>
  );
}
