declare module "virtual:custom-tool-runtime-worker" {
  const source: string;
  export default source;
}

declare module "virtual:custom-tool-authoring-runtime" {
  const source: string;
  export default source;
}

interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string;
  readonly VITE_APP_REVISION?: string;
}
