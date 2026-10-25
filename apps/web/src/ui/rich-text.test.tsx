import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { m } from "~/paraglide/messages.js";
import { RichText } from "./rich-text.tsx";

describe("RichText", () => {
  it("draws a tag inside one sentence where each language puts it", () => {
    const { container } = render(
      <p>
        <RichText
          parts={m.settings_apps_setup_key.parts({}, { locale: "de" })}
          tags={{ link: (children) => <a href="/settings/api-keys">{children}</a> }}
        />
      </p>,
    );
    expect(screen.getByRole("link", { name: "API-Schlüssel" })).toBeInTheDocument();
    expect(container).toHaveTextContent(
      "Erstelle unter API-Schlüssel einen Schlüssel und sende ihn im Authorization-Header.",
    );
  });
});
