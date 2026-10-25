import { m } from "~/paraglide/messages.js";
import type { ComponentProps, ComponentType } from "react";
import { localized } from "~/i18n/localized.ts";
import type { Localized } from "~/i18n/localized.ts";
import type { IntegrationCategory } from "../manifest.ts";
import {
  AirtableLogo,
  AsanaLogo,
  AtlassianLogo,
  CanvaLogo,
  CloudflareLogo,
  LinearLogo,
  NotionLogo,
  SentryLogo,
  StripeLogo,
  SupabaseLogo,
  TrelloLogo,
  VercelLogo,
  ZapierLogo,
} from "./known-server-logos.tsx";

/**
 * A remote MCP server people commonly add, so an admin picks it by name and
 * every screen draws its logo. Only the address and the sign-in are preset:
 * its tools are listed live to each account like any other server's.
 */
export interface KnownMcpServer {
  readonly id: string;
  readonly name: string;
  readonly description: Localized;
  readonly url: string;
  readonly category: IntegrationCategory;
  readonly logo: ComponentType<ComponentProps<"svg">>;
  /**
   * What someone at the service must do before anyone here can sign in,
   * given this app's address. Shown before the sign-in, which would only fail.
   */
  readonly setup?: (origin: string) => Localized;
  /**
   * Its sign-in lets in only apps registered there, so an admin brings one: it is
   * added off, opens on the client ID and secret, and stays off without them.
   */
  readonly ownApp?: boolean;
}

/**
 * Each one checked to sign in without registering an app first (dynamic
 * client registration or a client metadata document), so the preset needs
 * nothing from the admin but a sign-in, except where `ownApp` says otherwise.
 */
export const KNOWN_MCP_SERVERS: ReadonlyArray<KnownMcpServer> = [
  {
    id: "trello",
    name: "Trello",
    description: localized(m.integrations_known_trello_description),
    url: "https://mcp.trello.com/v1",
    category: "projects",
    logo: TrelloLogo,
  },
  {
    id: "atlassian",
    name: "Atlassian",
    description: localized(m.integrations_known_atlassian_description),
    url: "https://mcp.atlassian.com/v1/mcp",
    category: "projects",
    logo: AtlassianLogo,
    // Atlassian lets in only domains its organization admin allowed, beside its own partners.
    setup: (origin) => localized(m.integrations_known_atlassian_setup, { origin }),
  },
  {
    id: "asana",
    name: "Asana",
    description: localized(m.integrations_known_asana_description),
    url: "https://mcp.asana.com/v2/mcp",
    category: "projects",
    logo: AsanaLogo,
    // Its V2 server registers no apps itself; V1, which did, is shut down.
    ownApp: true,
    setup: () => localized(m.integrations_known_asana_setup),
  },
  {
    id: "linear",
    name: "Linear",
    description: localized(m.integrations_known_linear_description),
    url: "https://mcp.linear.app/mcp",
    category: "projects",
    logo: LinearLogo,
  },
  {
    id: "notion",
    name: "Notion",
    description: localized(m.integrations_known_notion_description),
    url: "https://mcp.notion.com/mcp",
    category: "docs",
    logo: NotionLogo,
  },
  {
    id: "sentry",
    name: "Sentry",
    description: localized(m.integrations_known_sentry_description),
    url: "https://mcp.sentry.dev/mcp",
    category: "developer",
    logo: SentryLogo,
  },
  {
    id: "canva",
    name: "Canva",
    description: localized(m.integrations_known_canva_description),
    url: "https://mcp.canva.com/mcp",
    category: "productivity",
    logo: CanvaLogo,
  },
  {
    id: "stripe",
    name: "Stripe",
    description: localized(m.integrations_known_stripe_description),
    url: "https://mcp.stripe.com/",
    category: "developer",
    logo: StripeLogo,
  },
  {
    id: "vercel",
    name: "Vercel",
    description: localized(m.integrations_known_vercel_description),
    url: "https://mcp.vercel.com/",
    category: "developer",
    logo: VercelLogo,
  },
  {
    id: "supabase",
    name: "Supabase",
    description: localized(m.integrations_known_supabase_description),
    url: "https://mcp.supabase.com/mcp",
    category: "developer",
    logo: SupabaseLogo,
  },
  {
    id: "airtable",
    name: "Airtable",
    description: localized(m.integrations_known_airtable_description),
    url: "https://mcp.airtable.com/mcp",
    category: "productivity",
    logo: AirtableLogo,
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: localized(m.integrations_known_cloudflare_description),
    url: "https://mcp.cloudflare.com/mcp",
    category: "developer",
    logo: CloudflareLogo,
  },
  {
    id: "zapier",
    name: "Zapier",
    description: localized(m.integrations_known_zapier_description),
    url: "https://mcp.zapier.com/api/mcp/mcp",
    category: "productivity",
    logo: ZapierLogo,
  },
];

/** A preset by its id, as integrations carry it. */
export const findKnownMcpServer = (id: string | null | undefined) =>
  KNOWN_MCP_SERVERS.find((server) => server.id === id) ?? null;

/** The preset at exactly this address: what a person without the right to add any server may add. */
export const knownMcpServerWithUrl = (url: string | undefined) =>
  KNOWN_MCP_SERVERS.find((server) => server.url === url) ?? null;

const hostOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

const BY_HOST = new Map(KNOWN_MCP_SERVERS.map((server) => [hostOf(server.url), server]));

/**
 * Which preset a server address belongs to, by host alone: each of these
 * services keeps its MCP server on a host of its own, so an older path (an
 * SSE endpoint) or one added by hand is still recognised.
 */
export const knownMcpServerAt = (url: string | undefined) => {
  const host = hostOf(url);
  return host ? (BY_HOST.get(host) ?? null) : null;
};
