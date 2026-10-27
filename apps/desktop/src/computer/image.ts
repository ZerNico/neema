/**
 * The guest image every chat's VM boots (infra/sandbox-image), fixed at build time by digest so
 * a new image ships with a desktop release; a chat whose disk was made from another image starts
 * its environment over. `NEEMA_SANDBOX_IMAGE` points development at a local build, with
 * `NEEMA_SANDBOX_INSECURE=1` for a plain-HTTP registry.
 */
export const SANDBOX_IMAGE = process.env.NEEMA_SANDBOX_IMAGE ?? __SANDBOX_IMAGE__;

export const SANDBOX_INSECURE_REGISTRY = process.env.NEEMA_SANDBOX_INSECURE === "1";
