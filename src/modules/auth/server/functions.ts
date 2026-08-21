import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { auth } from "./auth.ts";

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
  return auth.api.getSession({ headers: getRequestHeaders() });
});
