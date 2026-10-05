import { queryOptions } from "@tanstack/react-query";
import { listPresentationFonts } from "../server/font-functions.ts";

export const presentationFontsQuery = queryOptions({
  queryKey: ["admin", "presentation-fonts"],
  queryFn: () => listPresentationFonts(),
});
