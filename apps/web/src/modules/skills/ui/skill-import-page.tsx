import { ArrowRight01Icon, Upload04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cardSurfaceClassName } from "~/ui/card-surface.ts";
import { ErrorState, ListCard, ListRow, ListSkeleton, Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import { FieldError } from "~/ui/primitives/field";
import { Skeleton } from "~/ui/primitives/skeleton";
import { Spinner } from "~/ui/primitives/spinner";
import { SearchInput } from "~/ui/search-input.tsx";
import { cn } from "~/ui/utils.ts";
import { m } from "~/paraglide/messages.js";
import { formatLocale } from "~/i18n/formats.ts";
import { getLocale } from "~/paraglide/runtime.js";
import { findingsText } from "../finding-text.ts";
import { readSkillArchive, selectSkillPackage, skillPackageRoots } from "../archive.ts";
import {
  decodeSkillText,
  isBinarySkillFile,
  SKILL_LIMITS,
  SkillPackageError,
  validateSkillPackage,
  type SkillFile,
  type ValidatedSkillPackage,
} from "../package.ts";
import { DISCOVERY_MAX, DISCOVERY_PAGE } from "../schema.ts";
import { saveSkill } from "../server/functions.ts";
import { skillFileInput, uploadSkillFile } from "../client/files.ts";
import { formatFileSize } from "~/modules/attachments/constants.ts";
import {
  importReviewedSkill,
  reviewRemoteSkill,
  searchDiscoverableSkills,
} from "../server/import-functions.ts";
import { PackageWorkspace } from "./package-workspace.tsx";

const MIN_SEARCH = 2;
/** A ZIP's binary files go up first; the save then names them by upload. */
const uploadBinaries = (files: readonly SkillFile[]) =>
  Promise.all(
    files.map(async (file) => {
      if (!isBinarySkillFile(file) || !file.bytes) return skillFileInput(file);
      const name = file.path.slice(file.path.lastIndexOf("/") + 1);
      const stored = await uploadSkillFile(new File([new Uint8Array(file.bytes)], name));
      return skillFileInput({ path: file.path, binary: stored });
    }),
  );

/** A link is anything that names a host we can actually fetch a package from. */
const isSkillLink = (value: string) =>
  /^(https?:\/\/|(www\.)?(github\.com|skills\.sh)\/)/iu.test(value.trim());

const message = (cause: unknown, fallback: string) =>
  cause instanceof SkillPackageError
    ? findingsText(cause.findings, getLocale())
    : cause instanceof Error
      ? cause.message
      : fallback;

/** Nothing is trusted as an id to navigate to until it is one. */
const importedId = async (result: unknown): Promise<string> => {
  if (typeof result === "string" && result.length > 0) return result;
  throw new Error(m.skills_import_no_id());
};

/**
 * Opening a package is a navigation: the reviewed source lives in the URL, so
 * the router owns Back, a refresh keeps the review, and one query owns the
 * wait. Uploaded bytes cannot live in a URL, so those stay in local state.
 */
export function SkillImportPage({ source, path }: { source?: string; path?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // One field takes both a search term and a link; the shape of what is typed
  // decides which it is, so there is no mode to pick first.
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const [uploaded, setUploaded] = useState<ValidatedSkillPackage | null>(null);
  const [archive, setArchive] = useState<SkillFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [limit, setLimit] = useState(DISCOVERY_PAGE);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setLimit(DISCOVERY_PAGE);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const link = isSkillLink(query);
  // Two characters keeps the first keystroke off the network.
  const searchable = !link && search.length >= MIN_SEARCH;
  const discovery = useQuery({
    queryKey: ["skills-discovery", search, limit],
    queryFn: ({ signal }) => searchDiscoverableSkills({ data: { query: search, limit }, signal }),
    placeholderData: (previous) => previous,
    enabled: searchable,
    retry: false,
    staleTime: 60_000,
  });
  // Reading a package costs upstream requests, so it is fetched once for the
  // URL it belongs to and never refetched behind the reader's back.
  const remote = useQuery({
    queryKey: ["skill-review", source, path],
    queryFn: ({ signal }) =>
      reviewRemoteSkill({
        data: { url: source!, ...(path === undefined ? {} : { path }) },
        signal,
      }),
    enabled: !!source,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const open = (next: string, within?: string) => {
    setError(null);
    setUploaded(null);
    setArchive(null);
    void navigate({
      to: "/skills/import",
      search: { source: next, ...(within === undefined ? {} : { path: within }) },
    });
  };
  const back = () => {
    setError(null);
    setUploaded(null);
    setArchive(null);
    void navigate({ to: "/skills/import", search: {} });
  };
  const readFile = async (file: File) => {
    setError(null);
    setReading(true);
    try {
      if (file.size > SKILL_LIMITS.archiveBytes)
        throw new Error(
          m.skills_import_file_too_large({
            size: formatFileSize(SKILL_LIMITS.archiveBytes, formatLocale()),
          }),
        );
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (/\.zip$/iu.test(file.name)) {
        const files = readSkillArchive(bytes);
        const roots = skillPackageRoots(files);
        if (!roots.length) throw new Error(m.skills_import_zip_empty());
        setArchive(files);
        setUploaded(roots.length === 1 ? selectSkillPackage(files, roots[0]!) : null);
      } else if (/\.md$/iu.test(file.name)) {
        setArchive(null);
        setUploaded(
          validateSkillPackage([{ path: "SKILL.md", content: decodeSkillText(bytes, file.name) }]),
        );
      } else throw new Error(m.skills_import_wrong_type());
    } catch (cause) {
      setError(message(cause, m.skills_import_read_failed()));
    } finally {
      setReading(false);
    }
  };
  const selected = remote.data?.selected;
  const review = uploaded ?? selected?.package ?? null;
  const reviewed = uploaded ? null : (selected?.source ?? null);
  const importSkill = async () => {
    if (!review) return;
    setImporting(true);
    setError(null);
    try {
      await importedId(
        reviewed
          ? await importReviewedSkill({
              data: {
                repository: reviewed.repository,
                commit: reviewed.commit,
                path: reviewed.path,
                contentHash: reviewed.contentHash,
              },
            })
          : (await saveSkill({ data: { files: await uploadBinaries(review.files) } })).id,
      );
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast.success(m.skills_import_imported({ name: review.metadata.name }));
      await navigate({ to: "/skills" });
    } catch (cause) {
      setError(message(cause, m.skills_import_failed()));
    } finally {
      setImporting(false);
    }
  };
  const opened = source
    ? discovery.data?.skills.find((skill) => source.endsWith(`/${skill.source}/${skill.skillId}`))
    : undefined;
  const waiting = remote.isFetching || reading;
  const failure =
    error ?? (remote.error ? message(remote.error, m.skills_import_read_failed()) : null);
  return (
    <Page
      title={review ? review.metadata.name : (opened?.name ?? m.skills_import_title())}
      {...(source || archive
        ? { onBack: back, backLabel: m.skills_import_back() }
        : { backTo: "/skills", backLabel: m.skills_title() })}
      description={
        review
          ? selected
            ? `${remote.data!.repository}/${selected.source.path} · ${remote.data!.commit}`
            : m.skills_import_uploaded()
          : waiting
            ? (opened?.source ?? m.skills_import_reading())
            : m.skills_import_description()
      }
      actions={
        review ? (
          <PendingButton
            size="sm"
            pending={importing}
            onClick={() => {
              void importSkill();
            }}
          >
            {m.skills_import_submit()}
          </PendingButton>
        ) : null
      }
    >
      {failure ? <FieldError className="whitespace-pre-wrap">{failure}</FieldError> : null}
      {waiting ? (
        <div
          role="status"
          aria-label={m.skills_import_reading_label()}
          className={cn(cardSurfaceClassName, "grid min-w-0 md:grid-cols-[13rem_minmax(0,1fr)]")}
        >
          <div className="flex flex-col gap-2 border-b p-3 md:border-r md:border-b-0">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-7" />
            ))}
          </div>
          <div className="text-muted-foreground flex min-h-64 items-center justify-center gap-2 text-sm">
            <Spinner aria-hidden />
            {m.skills_import_reading()}
          </div>
        </div>
      ) : review ? (
        <PackageWorkspace files={review.files} readOnly findings={review.findings} />
      ) : (
        <>
          {/* One source can hold several packages; choose before reviewing. */}
          {remote.data?.choices.length ? (
            <Section title={m.skills_import_choose()}>
              <ListCard>
                {remote.data.choices.map((choice) => (
                  <button
                    type="button"
                    className="block w-full text-left"
                    key={choice.path}
                    onClick={() => open(source!, choice.path)}
                  >
                    <ListRow interactive>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{choice.name}</p>
                        <p className="text-muted-foreground text-xs">
                          {choice.path || m.skills_import_repository_root()}
                        </p>
                      </div>
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        strokeWidth={2}
                        aria-hidden
                        className="text-muted-foreground size-4 shrink-0"
                      />
                    </ListRow>
                  </button>
                ))}
              </ListCard>
            </Section>
          ) : null}
          {archive ? (
            <Section title={m.skills_import_choose()}>
              <ListCard>
                {skillPackageRoots(archive).map((root) => (
                  <button
                    type="button"
                    className="block w-full text-left"
                    key={root}
                    onClick={() => {
                      try {
                        setUploaded(selectSkillPackage(archive, root));
                      } catch (cause) {
                        setError(message(cause, m.skills_import_not_importable()));
                      }
                    }}
                  >
                    <ListRow interactive>{root || m.skills_import_main_folder()}</ListRow>
                  </button>
                ))}
              </ListCard>
            </Section>
          ) : null}
          {source || archive ? null : (
            <>
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (link) open(query.trim());
                }}
              >
                <SearchInput
                  className="min-w-56 flex-1"
                  aria-label={m.skills_import_search()}
                  placeholder={m.skills_import_search_placeholder()}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {link ? <Button type="submit">{m.skills_import_review()}</Button> : null}
                <Button variant="outline" onClick={() => upload.current?.click()}>
                  <HugeiconsIcon icon={Upload04Icon} strokeWidth={2} data-icon="inline-start" />
                  {m.skills_import_upload()}
                </Button>
                <input
                  ref={upload}
                  type="file"
                  accept=".md,.zip"
                  className="sr-only"
                  aria-label={m.skills_import_upload_label()}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void readFile(file);
                    event.target.value = "";
                  }}
                />
              </form>
              {discovery.isError && searchable ? (
                <ErrorState
                  title={m.skills_import_discovery_failed()}
                  description={m.skills_import_discovery_failed_description()}
                  onRetry={() => {
                    void discovery.refetch();
                  }}
                />
              ) : null}
              {searchable && discovery.isPending ? (
                <ListSkeleton rows={4} media="none" label={m.skills_import_searching()} />
              ) : null}
              {searchable && !discovery.isPending && discovery.data?.skills.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {m.skills_import_no_results({ query: search })}
                </p>
              ) : null}
              {searchable && discovery.data?.skills.length ? (
                <ListCard>
                  {discovery.data.skills.map((skill) => (
                    <button
                      type="button"
                      className="block w-full text-left"
                      key={`${skill.source}/${skill.skillId}`}
                      onClick={() => open(`https://skills.sh/${skill.source}/${skill.skillId}`)}
                    >
                      <ListRow interactive>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{skill.name}</p>
                          <p className="text-muted-foreground truncate text-xs">
                            {m.skills_import_installs({
                              source: skill.source,
                              count: skill.installs,
                              installs: skill.installs.toLocaleString(formatLocale()),
                            })}
                          </p>
                        </div>
                        <HugeiconsIcon
                          icon={ArrowRight01Icon}
                          strokeWidth={2}
                          aria-hidden
                          className="text-muted-foreground size-4 shrink-0"
                        />
                      </ListRow>
                    </button>
                  ))}
                  {/* The next rows land where these sit. */}
                  {discovery.isFetching
                    ? [0, 1, 2].map((key) => (
                        <ListRow key={key}>
                          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                            <Skeleton className="h-3.5 w-40 max-w-full" />
                            <Skeleton className="h-3 w-56 max-w-full" />
                          </div>
                        </ListRow>
                      ))
                    : null}
                </ListCard>
              ) : null}
              {/* skills.sh ignores an offset, so more results means a larger
                  page; the ordering is stable, so nothing on screen moves. */}
              {searchable &&
              !discovery.isFetching &&
              discovery.data?.received === limit &&
              limit < DISCOVERY_MAX ? (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLimit((current) => Math.min(current * 3, DISCOVERY_MAX))}
                  >
                    {m.skills_import_show_more()}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </Page>
  );
}
