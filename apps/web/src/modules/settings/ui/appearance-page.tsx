import { ComputerIcon, Moon02Icon, Sun03Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { LanguageSection } from "~/modules/language/ui/language-section.tsx";
import { Page, Section } from "~/ui/page-shell.tsx";
import {
  COLOR_SCHEMES,
  type ColorScheme,
  type Theme,
  setColorScheme,
  setTheme,
  useColorScheme,
  useTheme,
} from "~/ui/theme.tsx";
import { cn } from "~/ui/utils";
import { m } from "~/paraglide/messages.js";

// Scheme names are names, the same in every language.
const SCHEME_LABELS: Record<ColorScheme, string> = {
  iris: "Iris",
  stone: "Stone",
  cobalt: "Cobalt",
  matcha: "Matcha",
  ocean: "Ocean",
  clay: "Clay",
  cherry: "Cherry",
  "rose-pine": "Rosé Pine",
  "t3-chat": "T3 Chat",
  classic: "Classic",
};

const MODES: Array<{ value: Theme; label: () => string; icon: IconSvgElement }> = [
  { value: "light", label: m.settings_appearance_light, icon: Sun03Icon },
  { value: "system", label: m.settings_appearance_system, icon: ComputerIcon },
  { value: "dark", label: m.settings_appearance_dark, icon: Moon02Icon },
];

const GRID = "grid grid-cols-2 gap-3 sm:grid-cols-3";

/** How the app looks on this device, and the language it reads in everywhere. */
export function AppearancePage() {
  const scheme = useColorScheme();
  const mode = useTheme();
  return (
    <Page
      title={m.settings_section_appearance()}
      rootPath="/settings"
      rootLabel={m.common_settings()}
    >
      <Section title={m.settings_appearance_theme()}>
        <div role="radiogroup" aria-label={m.settings_appearance_theme()} className={GRID}>
          {COLOR_SCHEMES.map((option) => (
            <OptionCard
              key={option}
              label={SCHEME_LABELS[option]}
              selected={option === scheme}
              onSelect={() => setColorScheme(option)}
            >
              {/* `.paper` starts the light half from the light neutrals. */}
              <SchemePreview scheme={option} className="paper" />
              <SchemePreview scheme={option} className="dark" />
            </OptionCard>
          ))}
        </div>
      </Section>
      <Section title={m.settings_appearance_mode()}>
        <div role="radiogroup" aria-label={m.settings_appearance_mode()} className={GRID}>
          {MODES.map((option) => (
            <OptionCard
              key={option.value}
              label={option.label()}
              icon={option.icon}
              selected={option.value === mode}
              onSelect={() => setTheme(option.value)}
            >
              {option.value === "dark" ? null : <SchemePreview scheme={scheme} className="paper" />}
              {option.value === "light" ? null : <SchemePreview scheme={scheme} className="dark" />}
            </OptionCard>
          ))}
        </div>
      </Section>
      <LanguageSection />
    </Page>
  );
}

function OptionCard({
  label,
  icon,
  selected,
  onSelect,
  children,
}: {
  label: string;
  icon?: IconSvgElement;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "focus-visible:ring-ring flex flex-col gap-2 rounded-xl p-1.5 text-left outline-none focus-visible:ring-2",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <span
        className={cn(
          "flex h-20 overflow-hidden rounded-lg ring-1",
          selected ? "ring-primary ring-2" : "ring-border",
        )}
      >
        {children}
      </span>
      <span className="flex items-center gap-1.5 px-1 text-sm font-medium">
        {icon ? (
          <HugeiconsIcon icon={icon} strokeWidth={2} className="text-muted-foreground size-4" />
        ) : null}
        {label}
        {selected ? (
          <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="text-primary size-4" />
        ) : null}
      </span>
    </button>
  );
}

/** Carries the scheme itself, so it draws from the same tokens as the app. */
function SchemePreview({ scheme, className }: { scheme: ColorScheme; className: string }) {
  return (
    <span
      data-scheme={scheme}
      className={cn("bg-sidebar flex flex-1 py-1.5 pr-1.5 pl-3", className)}
    >
      <span className="bg-background ring-sidebar-border flex flex-1 flex-col justify-between rounded-md p-1.5 ring-1">
        <span className="bg-primary/12 h-2 w-3/5 self-end rounded-full" />
        <span className="bg-muted-foreground/40 h-1 w-4/5 rounded-full" />
        <span className="bg-primary size-2.5 self-end rounded-full" />
      </span>
    </span>
  );
}
