import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Box } from "@chat/sheet/model";
import {
  chartData,
  readSource,
  rebuildSeries,
  suggestKinds,
  type ChartKind,
  type ChartSeries,
  type ChartSource,
  type SeriesKind,
} from "@chat/sheet/model/chart";
import { Button } from "~/ui/primitives/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/ui/primitives/collapsible";
import { Field, FieldLabel } from "~/ui/primitives/field";
import { SortableHandle, SortableItem, SortableList } from "~/ui/sortable-list";
import { cn } from "~/ui/utils";
import { seriesColor } from "../chart-compile.ts";
import { CHART_KINDS, COMBINING, SINGLE, STACKING } from "../chart-kinds.ts";
import { ColorField, CommitInput, SelectField, SwitchField } from "./controls.tsx";
import { rangeText, readRange, readText, textOf } from "./ranges.ts";
import { without, type EditorContext } from "./setup-model.ts";

const STACKS = [
  { value: "none", label: "Side by side" },
  { value: "stacked", label: "Stacked" },
  { value: "percent", label: "100% stacked" },
] as const;
const SERIES_KINDS = [
  { value: "column", label: "Column" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
] as const;
const AXES = [
  { value: "left", label: "Left axis" },
  { value: "right", label: "Right axis" },
] as const;

/** One kind to pick, drawn as its icon and name. */
function KindTile({
  kind,
  current,
  disabled,
  onPick,
}: {
  kind: (typeof CHART_KINDS)[number];
  current: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={current}
      disabled={disabled}
      className={cn(
        "border-border hover:bg-accent focus-visible:ring-ring/50 flex flex-col items-center gap-1 rounded-xl border p-2 text-xs outline-none focus-visible:ring-2 disabled:opacity-50",
        current && "border-primary bg-primary/10",
      )}
      onClick={onPick}
    >
      <HugeiconsIcon icon={kind.icon} strokeWidth={2} className="size-5" />
      {kind.label}
    </button>
  );
}

/** What a chart draws and from where: its kind, its range and how that is read, its series. */
export function ChartSetup({ doc, values, chart, readOnly, selection, patch }: EditorContext) {
  const source = chart.source;
  const recommended = source ? suggestKinds(doc, values, source).slice(0, 3) : [];
  const setKind = (kind: ChartKind) => {
    if (kind === chart.kind) return;
    // Read again from the range, so a pie keeps one series and a column chart gets them all back.
    patch(
      source ? { kind, series: rebuildSeries(doc, { ...chart, kind }, source).series } : { kind },
    );
  };
  const setSource = (next: ChartSource) => {
    const rebuilt = rebuildSeries(doc, chart, next);
    patch({ source: rebuilt.source ?? null, series: rebuilt.series });
  };
  const pickRange = (sheet: string, box: Box) => setSource(readSource(doc, values, sheet, box));
  const setSeries = (series: readonly ChartSeries[]) => patch({ series });
  const change = (index: number, edit: (series: ChartSeries) => ChartSeries) =>
    setSeries(chart.series.map((each, at) => (at === index ? edit(each) : each)));
  const sourceText = source ? rangeText(doc, chart.sheet, source.sheet, source.box) : "";
  const first = chart.series[0];
  const labelsText = first?.categories
    ? rangeText(doc, chart.sheet, first.sheet ?? chart.sheet, first.categories)
    : "";
  const combos = COMBINING.has(chart.kind);
  const shownNames = chartData(doc, values, chart).series.map((each) => each.name);

  return (
    <div className="flex flex-col gap-5">
      <Field>
        <FieldLabel>Chart type</FieldLabel>
        {recommended.length ? (
          <>
            <span className="text-muted-foreground text-xs">Recommended</span>
            <div className="grid grid-cols-3 gap-2">
              {recommended.map((kind) => (
                <KindTile
                  key={kind}
                  kind={CHART_KINDS.find((each) => each.kind === kind)!}
                  current={chart.kind === kind}
                  disabled={readOnly}
                  onPick={() => setKind(kind)}
                />
              ))}
            </div>
            <span className="text-muted-foreground text-xs">All charts</span>
          </>
        ) : null}
        <div className="grid grid-cols-3 gap-2">
          {CHART_KINDS.map((kind) => (
            <KindTile
              key={kind.kind}
              kind={kind}
              current={chart.kind === kind.kind}
              disabled={readOnly}
              onPick={() => setKind(kind.kind)}
            />
          ))}
        </div>
      </Field>
      {STACKING.has(chart.kind) ? (
        <SelectField
          label="Stacking"
          value={chart.stack ?? "none"}
          options={STACKS}
          disabled={readOnly}
          onChange={(stack) => patch({ stack: stack === "none" ? null : stack })}
        />
      ) : null}
      <div className="flex flex-col gap-2">
        <CommitInput
          label="Data range"
          value={sourceText}
          placeholder="A1:D12"
          invalid={sourceText === "#REF!"}
          disabled={readOnly}
          onCommit={(text) => {
            const range = readRange(doc, chart.sheet, text);
            if (range) pickRange(range.sheet, range.box);
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={readOnly}
          onClick={() => pickRange(selection.sheet, selection.box)}
        >
          Use selection
        </Button>
      </div>
      {source ? (
        <div className="flex flex-col gap-3">
          <SwitchField
            label="First row is headers"
            checked={source.headers}
            disabled={readOnly}
            onChange={(headers) => setSource({ ...source, headers })}
          />
          <SwitchField
            label="First column is labels"
            checked={source.labels}
            disabled={readOnly}
            onChange={(labels) => setSource({ ...source, labels })}
          />
          <SwitchField
            label="Switch rows and columns"
            checked={source.byRow}
            disabled={readOnly}
            onChange={(byRow) => setSource({ ...source, byRow })}
          />
        </div>
      ) : null}
      <CommitInput
        label={chart.kind === "scatter" || chart.kind === "bubble" ? "X values" : "Labels"}
        value={labelsText}
        placeholder="A2:A12"
        invalid={labelsText === "#REF!"}
        disabled={readOnly}
        onCommit={(text) => {
          const range = text.trim() ? readRange(doc, chart.sheet, text) : null;
          if (text.trim() && !range) return;
          setSeries(chart.series.map((each) => without(each, "categories", range?.box ?? null)));
        }}
      />
      <Field>
        <FieldLabel>Series</FieldLabel>
        <SortableList
          className="flex flex-col"
          onMove={(from, to) => {
            const next = [...chart.series];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved!);
            setSeries(next);
          }}
        >
          {chart.series.map((series, index) => {
            // A name read from a cell shows as the cell does.
            const name = shownNames[index] || `Series ${index + 1}`;
            const range = rangeText(doc, chart.sheet, series.sheet ?? chart.sheet, series.values);
            return (
              // Series have no IDs of their own; their ranges stand in for them.
              <SortableItem
                key={`${series.sheet ?? ""}:${series.values.r1}:${series.values.c1}:${series.values.r2}:${series.values.c2}`}
                id={`series-${index}`}
                index={index}
                className="border-border border-b"
              >
                <Collapsible>
                  <div className="flex items-center gap-1 py-1">
                    {readOnly ? null : <SortableHandle label={name} />}
                    <ColorField
                      label={`${name} colour`}
                      value={series.color}
                      automatic={seriesColor(undefined, index)}
                      disabled={readOnly}
                      onChange={(color) => change(index, (each) => without(each, "color", color))}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="min-w-0 flex-1 justify-start"
                      render={<CollapsibleTrigger />}
                    >
                      <span className="truncate">{name}</span>
                      <span
                        className={cn(
                          "text-xs",
                          range === "#REF!" ? "text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {range}
                      </span>
                    </Button>
                    {readOnly ? null : (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove ${name}`}
                        disabled={chart.series.length === 1}
                        onClick={() => setSeries(chart.series.filter((_, at) => at !== index))}
                      >
                        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                      </Button>
                    )}
                  </div>
                  <CollapsibleContent>
                    <div className="flex flex-col gap-3 pb-3">
                      <CommitInput
                        label="Name"
                        value={textOf(doc, chart.sheet, series.name)}
                        placeholder={`Series ${index + 1}, or =B1`}
                        disabled={readOnly}
                        onCommit={(text) =>
                          change(index, (each) =>
                            without(each, "name", readText(doc, chart.sheet, text)),
                          )
                        }
                      />
                      <CommitInput
                        label="Values"
                        value={range}
                        invalid={range === "#REF!"}
                        disabled={readOnly}
                        onCommit={(text) => {
                          const found = readRange(doc, chart.sheet, text);
                          if (!found) return;
                          change(index, (each) => {
                            const moved = { ...each, values: found.box };
                            return without(
                              moved,
                              "sheet",
                              found.sheet === chart.sheet ? null : found.sheet,
                            );
                          });
                        }}
                      />
                      {combos ? (
                        <>
                          <SelectField
                            label="Draw as"
                            value={series.kind ?? (chart.kind as SeriesKind)}
                            options={SERIES_KINDS}
                            disabled={readOnly}
                            onChange={(kind) =>
                              change(index, (each) =>
                                without(each, "kind", kind === chart.kind ? null : kind),
                              )
                            }
                          />
                          <SelectField
                            label="Axis"
                            value={series.axis ?? "left"}
                            options={AXES}
                            disabled={readOnly}
                            onChange={(axis) =>
                              change(index, (each) =>
                                without(each, "axis", axis === "left" ? null : axis),
                              )
                            }
                          />
                        </>
                      ) : null}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </SortableItem>
            );
          })}
        </SortableList>
        {readOnly || SINGLE.has(chart.kind) ? null : (
          <Button
            size="sm"
            variant="outline"
            disabled={chart.series.length >= 12}
            onClick={() =>
              setSeries([
                ...chart.series,
                {
                  values: selection.box,
                  ...(selection.sheet === chart.sheet ? {} : { sheet: selection.sheet }),
                  ...(first?.categories ? { categories: first.categories } : {}),
                },
              ])
            }
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            Add series from selection
          </Button>
        )}
      </Field>
    </div>
  );
}
