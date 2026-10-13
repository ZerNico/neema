import { expect, test } from "vitest";
import { childEnvironment } from "../index.ts";

const proxyUrl = "http://cmd:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG@127.0.0.1:43123";
const variables = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "GRPC_PROXY",
  "grpc_proxy",
];

test.each(variables)("%s routes the child through its authenticated HTTP proxy", (name) => {
  expect(childEnvironment(proxyUrl)[name]).toBe(proxyUrl);
});

test.each(["NO_PROXY", "no_proxy"])("%s bypasses only the three loopback names", (name) => {
  expect(childEnvironment(proxyUrl)[name]).toBe("localhost,127.0.0.1,::1");
});

test("Git is configured for Basic proxy authentication on the first request", () => {
  const env = childEnvironment(proxyUrl);
  // Accept the documented Git environment override or either standard env-only config encoding.
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  const pairs = Array.from(
    { length: Number.isSafeInteger(count) && count >= 0 ? count : 0 },
    (_, index) => ({
      key: env[`GIT_CONFIG_KEY_${index}`]?.toLowerCase(),
      value: env[`GIT_CONFIG_VALUE_${index}`]?.toLowerCase(),
    }),
  );
  const explicit = env.GIT_HTTP_PROXY_AUTHMETHOD?.toLowerCase() === "basic";
  const config = pairs.some(
    ({ key, value }) => key === "http.proxyauthmethod" && value === "basic",
  );
  const parameters = /(?:^|[\s'"])http\.proxyAuthMethod(?:=|['"]\s*['"])basic(?:$|[\s'"])/i.test(
    env.GIT_CONFIG_PARAMETERS ?? "",
  );
  expect(explicit || config || parameters).toBe(true);
});

test("childEnvironment is pure and does not modify the current process environment", () => {
  const before = { ...process.env };
  const first = childEnvironment(proxyUrl);
  const second = childEnvironment(proxyUrl);
  expect(process.env).toEqual(before);
  expect(first).toEqual(second);
  expect(Object.values(first).every((value) => typeof value === "string")).toBe(true);
});

test("returned settings override inherited private-network bypasses", () => {
  const env = childEnvironment(proxyUrl);
  const merged = {
    HTTP_PROXY: "http://old-proxy:8080",
    NO_PROXY: "*",
    no_proxy: "10.0.0.0/8",
    ...env,
  };
  expect(merged.HTTP_PROXY).toBe(proxyUrl);
  expect(merged.NO_PROXY).toBe("localhost,127.0.0.1,::1");
  expect(merged.no_proxy).toBe("localhost,127.0.0.1,::1");
});

test("childEnvironment does not put tokens in JVM startup-option variables", () => {
  const env = childEnvironment(proxyUrl);
  for (const name of ["JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS"]) {
    expect(env[name] ?? "").not.toContain(new URL(proxyUrl).password);
    expect(env[name] ?? "").not.toContain("-javaagent");
  }
});
