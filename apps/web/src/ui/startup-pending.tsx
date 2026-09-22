import { Spinner } from "./primitives/spinner";

export function StartupPending() {
  return (
    <div className="text-muted-foreground flex h-svh max-h-full items-center justify-center">
      <Spinner />
    </div>
  );
}
