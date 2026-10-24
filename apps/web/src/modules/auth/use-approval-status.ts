import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { meQuery } from "./client.ts";

export function useApprovalStatus() {
  const query = useQuery({ ...meQuery, select: (me) => me?.approval ?? null });
  const client = useQueryClient();
  useEffect(() => {
    const source = new EventSource("/api/approval");
    let disposed = false;
    let refreshing = false;
    let dirty = false;
    const refresh = () => {
      if (disposed) return;
      if (refreshing) {
        dirty = true;
        return;
      }
      refreshing = true;
      dirty = client.isFetching({ queryKey: meQuery.queryKey }) > 0;
      void client
        .invalidateQueries({ queryKey: meQuery.queryKey }, { cancelRefetch: false })
        .finally(() => {
          refreshing = false;
          if (dirty && !disposed) refresh();
        });
    };
    source.addEventListener("approval", refresh);
    // An expired cookie can turn a reconnect into 401, with no SSE payload.
    source.addEventListener("error", refresh);
    return () => {
      disposed = true;
      source.close();
    };
  }, [client]);
  return query;
}
