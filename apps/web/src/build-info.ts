// Set by the image build (Dockerfile); a local build or dev server has neither.
const version = import.meta.env.VITE_APP_VERSION || "dev";
const revision = import.meta.env.VITE_APP_REVISION?.slice(0, 7);

/** "0.1.0 (1a2b3c4)", or "dev" outside a release build. */
export const BUILD_LABEL = revision ? `${version} (${revision})` : version;
