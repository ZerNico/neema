// Start's Vite plugin sets this in dev only; production must serve the same shell.
process.env.TSS_SHELL = "true";
await import("../.output/server/index.mjs");
