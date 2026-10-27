import { posix } from "node:path";

/**
 * The model's address space is the guest's, the same on every OS: the chat's workspace at
 * `/workspace` and each attached folder at `/folders/<name>`. Host paths never reach the model
 * or the server (docs/internals/desktop.md).
 */
export const WORKSPACE = "/workspace";
export const FOLDERS = "/folders";

/** One host directory shown to the guest. Names are unique per chat; `workspace` is reserved. */
export interface Mount {
  readonly name: string;
  readonly hostPath: string;
  readonly readOnly: boolean;
}

export const guestRoot = (mount: Mount | "workspace") =>
  mount === "workspace" ? WORKSPACE : `${FOLDERS}/${mount.name}`;

/** Where a guest path lands, or why it does not. */
export type Placed =
  | { readonly ok: true; readonly path: string; readonly root: string; readonly readOnly: boolean }
  | { readonly ok: false; readonly reason: "outside" | "not-absolute" };

/**
 * Normalizes a path the model named and checks it lies inside the workspace or an attached
 * folder. Containment past this point is the VM's: nothing outside the mounts exists there.
 * This check is for a clear answer, not for safety.
 */
export const place = (path: string, mounts: readonly Mount[]): Placed => {
  if (!path.startsWith("/")) return { ok: false, reason: "not-absolute" };
  const normal = posix.normalize(path).replace(/(.)\/$/, "$1");
  const roots = [
    { root: WORKSPACE, readOnly: false },
    ...mounts.map((mount) => ({ root: guestRoot(mount), readOnly: mount.readOnly })),
  ];
  const match = roots.find(({ root }) => normal === root || normal.startsWith(`${root}/`));
  return match ? { ok: true, path: normal, ...match } : { ok: false, reason: "outside" };
};

/** The roots in the order the model is told them: the workspace first, then the folders. */
export const roots = (mounts: readonly Mount[]) => [
  { name: "workspace", path: WORKSPACE, readOnly: false },
  ...mounts.map((mount) => ({
    name: mount.name,
    path: guestRoot(mount),
    readOnly: mount.readOnly,
  })),
];

/** Same mounts, same VM: anything else needs it recreated. */
export const mountKey = (workspace: string, mounts: readonly Mount[]) =>
  JSON.stringify([
    workspace,
    ...mounts.map(({ name, hostPath, readOnly }) => [name, hostPath, readOnly]).toSorted(),
  ]);
