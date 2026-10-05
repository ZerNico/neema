import { findIntegration } from "../catalog.ts";

export const integrationName = (integrationId: string) =>
  findIntegration(integrationId)?.name ?? integrationId;
