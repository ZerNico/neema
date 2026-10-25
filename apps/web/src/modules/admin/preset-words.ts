import type { Preset } from "@chat/model-client/presets";
import { m } from "~/paraglide/messages.js";
import { getLocale, type Locale } from "~/paraglide/runtime.js";

// Presets live in a package that knows no languages. Most of their words are
// product names; these are the few that are not, keyed by what the package says.

/** A preset's name: a product's own, except the one that describes a kind of server. */
export const presetLabel = (preset: Preset, locale: Locale = getLocale()) =>
  preset.id === "custom" ? m.admin_preset_custom({}, { locale }) : preset.label;

/** The base URL field's label, "Region" where a preset asks for one. */
export const baseUrlLabel = (preset: Preset, locale: Locale = getLocale()) =>
  preset.baseUrlLabel === "Region"
    ? m.admin_preset_region({}, { locale })
    : (preset.baseUrlLabel ?? m.admin_preset_base_url({}, { locale }));

/** The line under the service picker. */
export const presetNote = (preset: Preset, locale: Locale = getLocale()) =>
  preset.id === "azure"
    ? m.admin_preset_note_azure({}, { locale })
    : preset.id === "ollama"
      ? m.admin_preset_note_ollama({}, { locale })
      : preset.note;
