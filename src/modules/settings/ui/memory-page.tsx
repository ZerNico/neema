import { Brain02Icon } from "@hugeicons/core-free-icons";
import { AdminPage, EmptyState } from "~/modules/admin/ui/admin-shell.tsx";

// Placeholder for per-user assistant memory (facts the assistant remembers
// across chats). Ships with the settings shell so the section exists; the
// memory feature itself lands later.
export function MemoryPage() {
  return (
    <AdminPage
      title="Memory"
      description="What the assistant remembers about you across chats."
      rootPath="/settings"
      rootLabel="Settings"
    >
      <EmptyState
        icon={Brain02Icon}
        title="Memory is coming soon"
        description="Once available, you'll see and manage everything the assistant has remembered here."
      />
    </AdminPage>
  );
}
