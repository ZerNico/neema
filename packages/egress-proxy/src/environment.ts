export function childEnvironment(proxyUrl: string): Record<string, string> {
  return {
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    ALL_PROXY: proxyUrl,
    all_proxy: proxyUrl,
    GRPC_PROXY: proxyUrl,
    grpc_proxy: proxyUrl,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    GIT_HTTP_PROXY_AUTHMETHOD: "basic",
  };
}
