import { useState } from "react";
import {
  chartData,
  type ChartAxis,
  type ChartLabels,
  type ChartLine,
  type ChartSeries,
  type LegendPlace,
} from "@chat/sheet/model/chart";
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Slider } from "~/ui/primitives/slider";
import { seriesColor } from "../chart-compile.ts";
import {
  ColorField,
  CommitInput,
  FormatField,
  NumberInput,
  Section,
  SelectField,
  SwitchField,
} from "./controls.tsx";
import { readText, textOf } from "./ranges.ts";
import { without, type EditorContext } from "./setup-model.ts";

const LEGENDS: ReadonlyArray<{ value: LegendPlace; label: string }> = [
  { value: "none", label: "None" },
  { value: "top", label: "Top" },
  { value: "bottom", label: "Bottom" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
];
const LABEL_CONTENT = [
  { value: "value", label: "Value" },
  { value: "category", label: "Label" },
] as const;
const SLICE_CONTENT = [
  { value: "percent", label: "Percent" },
  { value: "value", label: "Value" },
  { value: "category", label: "Label" },
] as const;

/** An axis's options with one changed; null removes it, and an axis with none left goes. */
const axisWith = (
  axis: ChartAxis | undefined,
  change: { [K in keyof ChartAxis]?: ChartAxis[K] | null },
) => {
  const next: Record<string, unknown> = { ...axis };
  for (const [key, value] of Object.entries(change)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length ? (next as ChartAxis) : null;
};

/** A slider over a share from 0 to 1, shown as a percent, let go as one change. */
function ShareSlider({
  label,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  return (
    <Field>
      <FieldLabel>
        {label}
        <span className="text-muted-foreground ml-auto tabular-nums">
          {Math.round(shown * 100)}%
        </span>
      </FieldLabel>
      <Slider
        min={min}
        max={max}
        step={0.05}
        value={[shown]}
        disabled={disabled}
        aria-label={label}
        onValueChange={(next) => {
          const one = Array.isArray(next) ? next[0] : next;
          if (typeof one === "number") setDraft(one);
        }}
        onValueCommitted={(next) => {
          const one = Array.isArray(next) ? next[0] : next;
          if (typeof one === "number") onCommit(one);
          setDraft(null);
        }}
      />
    </Field>
  );
}

/** How a chart looks: titles, legend, axes, each series, and the kind's own options. */
export function ChartCustomize({ doc, values, chart, readOnly, patch }: EditorContext) {
  const names = chartData(doc, values, chart).series.map((each) => each.name);
  const [picked, setPicked] = useState(0);
  const at = Math.min(picked, chart.series.length - 1);
  const series = chart.series[at];
  const kind = chart.kind;
  const round = kind === "pie" || kind === "doughnut";
  const xy = kind === "scatter" || kind === "bubble";
  const lines =
    kind === "line" ||
    kind === "area" ||
    chart.series.some((each) => each.kind === "line" || each.kind === "area");
  const right = chart.series.some((each) => each.axis === "right");
  const setAxis = (key: "x" | "y" | "y2", change: Parameters<typeof axisWith>[1]) =>
    patch({ axes: { [key]: axisWith(chart.axes?.[key], change) } });
  const setSeries = (edit: (each: ChartSeries) => ChartSeries) =>
    patch({ series: chart.series.map((each, index) => (index === at ? edit(each) : each)) });
  const setLine = (change: Partial<ChartLine>) =>
    setSeries((each) => {
      const line = { ...each.line, ...change };
      return without(each, "line", Object.values(line).some(Boolean) ? line : null);
    });
  const setLabels = (change: Partial<ChartLabels>) =>
    setSeries((each) => {
      const labels: ChartLabels = { show: false, ...each.labels, ...change };
      return without(each, "labels", labels.show ? labels : null);
    });
  const sliceLabels = chart.style?.labels;
  const axisTitle = (key: "x" | "y" | "y2") => (
    <CommitInput
      label="Title"
      value={textOf(doc, chart.sheet, chart.axes?.[key]?.title)}
      placeholder="Text, or =A1"
      disabled={readOnly}
      onCommit={(text) => setAxis(key, { title: readText(doc, chart.sheet, text) })}
    />
  );
  const valueAxis = (key: "x" | "y" | "y2") => {
    const axis = chart.axes?.[key];
    return (
      <>
        {axisTitle(key)}
        <div className="grid grid-cols-2 gap-3">
          <NumberInput
            label="Minimum"
            value={axis?.min}
            disabled={readOnly}
            onCommit={(min) => setAxis(key, { min })}
          />
          <NumberInput
            label="Maximum"
            value={axis?.max}
            disabled={readOnly}
            onCommit={(max) => setAxis(key, { max })}
          />
        </div>
        <FormatField
          label="Number format"
          value={axis?.format}
          disabled={readOnly}
          onChange={(format) => setAxis(key, { format })}
        />
        <SwitchField
          label="Gridlines"
          checked={axis?.gridlines ?? key !== "y2"}
          disabled={readOnly}
          onChange={(gridlines) => setAxis(key, { gridlines })}
        />
        <SwitchField
          label="Logarithmic scale"
          checked={axis?.log ?? false}
          disabled={readOnly}
          onChange={(log) => setAxis(key, { log: log || null })}
        />
        <SwitchField
          label="Values in reverse order"
          checked={axis?.reverse ?? false}
          disabled={readOnly}
          onChange={(reverse) => setAxis(key, { reverse: reverse || null })}
        />
        <SwitchField
          label="Hide axis"
          checked={axis?.hidden ?? false}
          disabled={readOnly}
          onChange={(hidden) => setAxis(key, { hidden: hidden || null })}
        />
      </>
    );
  };

  return (
    <div className="flex flex-col">
      <Section title="Chart" defaultOpen>
        <CommitInput
          label="Title"
          value={textOf(doc, chart.sheet, chart.title)}
          placeholder="Text, or =A1"
          disabled={readOnly}
          onCommit={(text) => patch({ title: readText(doc, chart.sheet, text) })}
        />
        <CommitInput
          label="Subtitle"
          value={textOf(doc, chart.sheet, chart.subtitle)}
          disabled={readOnly}
          onCommit={(text) => patch({ subtitle: readText(doc, chart.sheet, text) })}
        />
        <SelectField
          label="Legend"
          value={chart.legend ?? "none"}
          options={LEGENDS}
          disabled={readOnly}
          onChange={(legend) => patch({ legend: legend === "none" ? null : legend })}
        />
      </Section>
      {round ? (
        <Section title="Slices" defaultOpen>
          {kind === "doughnut" ? (
            <ShareSlider
              label="Hole size"
              value={chart.style?.hole ?? 0.55}
              min={0.1}
              max={0.9}
              disabled={readOnly}
              onCommit={(hole) => patch({ style: { hole } })}
            />
          ) : null}
          <SwitchField
            label="Data labels"
            checked={sliceLabels?.show ?? false}
            disabled={readOnly}
            onChange={(show) =>
              patch({
                style: { labels: show ? { content: "percent", ...sliceLabels, show } : null },
              })
            }
          />
          {sliceLabels?.show ? (
            <SelectField
              label="Show"
              value={sliceLabels.content ?? "percent"}
              options={SLICE_CONTENT}
              disabled={readOnly}
              onChange={(content) => patch({ style: { labels: { ...sliceLabels, content } } })}
            />
          ) : null}
        </Section>
      ) : (
        <>
          <Section title="Horizontal axis">
            {xy || kind === "bar" || kind === "histogram" ? (
              valueAxis("x")
            ) : (
              <>
                {axisTitle("x")}
                <SwitchField
                  label="Labels in reverse order"
                  checked={chart.axes?.x?.reverse ?? false}
                  disabled={readOnly}
                  onChange={(reverse) => setAxis("x", { reverse: reverse || null })}
                />
                <SwitchField
                  label="Hide axis"
                  checked={chart.axes?.x?.hidden ?? false}
                  disabled={readOnly}
                  onChange={(hidden) => setAxis("x", { hidden: hidden || null })}
                />
              </>
            )}
          </Section>
          <Section title="Vertical axis">{valueAxis("y")}</Section>
          {right ? <Section title="Right axis">{valueAxis("y2")}</Section> : null}
        </>
      )}
      {series && !round && kind !== "histogram" ? (
        <Section title="Series">
          {chart.series.length > 1 ? (
            <SelectField
              label="Series"
              value={String(at)}
              options={chart.series.map((each, index) => ({
                value: String(index),
                label: names[index] || `Series ${index + 1}`,
              }))}
              onChange={(value) => setPicked(Number(value))}
            />
          ) : null}
          <Field orientation="horizontal">
            <FieldLabel>Colour</FieldLabel>
            <ColorField
              label="Series colour"
              value={series.color}
              automatic={seriesColor(undefined, at)}
              disabled={readOnly}
              onChange={(color) => setSeries((each) => without(each, "color", color))}
            />
          </Field>
          {lines ? (
            <>
              <SwitchField
                label="Smooth line"
                checked={series.line?.smooth ?? false}
                disabled={readOnly}
                onChange={(smooth) => setLine({ smooth, step: false })}
              />
              <SwitchField
                label="Steps"
                checked={series.line?.step ?? false}
                disabled={readOnly}
                onChange={(step) => setLine({ step, smooth: false })}
              />
              <SwitchField
                label="Markers"
                checked={series.line?.markers ?? false}
                disabled={readOnly}
                onChange={(markers) => setLine({ markers })}
              />
              <SwitchField
                label="Dashed"
                checked={series.line?.dashed ?? false}
                disabled={readOnly}
                onChange={(dashed) => setLine({ dashed })}
              />
            </>
          ) : null}
          <SwitchField
            label="Data labels"
            checked={series.labels?.show ?? false}
            disabled={readOnly}
            onChange={(show) => setLabels({ show })}
          />
          {series.labels?.show ? (
            <>
              <SelectField
                label="Show"
                value={series.labels.content === "category" ? "category" : "value"}
                options={LABEL_CONTENT}
                disabled={readOnly}
                onChange={(content) => setLabels({ content })}
              />
              <FormatField
                label="Label format"
                value={series.labels.format}
                disabled={readOnly}
                onChange={(format) =>
                  setSeries((each) => {
                    const { format: _old, ...rest } = each.labels ?? { show: true };
                    return { ...each, labels: format ? { ...rest, format } : rest };
                  })
                }
              />
            </>
          ) : null}
          {xy ? (
            <SwitchField
              label="Trendline"
              checked={series.trendline ?? false}
              disabled={readOnly}
              onChange={(trendline) =>
                setSeries((each) => without(each, "trendline", trendline || null))
              }
            />
          ) : null}
        </Section>
      ) : null}
      {kind === "column" || kind === "bar" || kind === "waterfall" ? (
        <Section title="Bars">
          <ShareSlider
            label="Gap width"
            value={chart.style?.gap ?? 0.25}
            min={0}
            max={0.9}
            disabled={readOnly}
            onCommit={(gap) => patch({ style: { gap } })}
          />
        </Section>
      ) : null}
    </div>
  );
}
