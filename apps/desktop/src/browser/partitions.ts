/** Main tells every preload which server's browser profile it may name. */
export const BROWSER_PROFILE_ARGUMENT = "--chat-desktop-browser-profile";

/**
 * The persistent profile shared by one server's chats. Imported by the
 * sandboxed preload, which cannot load Node modules, so the profile is hashed in
 * main (`profile.ts`) and only named here.
 */
export const sharedPartition = (profile: string) => `persist:browser-${profile}`;

/** No `persist:` prefix, so Chromium keeps it in memory and drops it with the app. */
export const temporaryPartition = (profile: string, conversationId: string) =>
  `browser-temp-${profile}-${conversationId}`;

const CONVERSATION_ID = /^[A-Za-z0-9-]{1,64}$/;

/** The only partitions a page may attach a guest to: its own server's. */
export const isBrowserPartition = (profile: string, partition: string) => {
  if (partition === sharedPartition(profile)) return true;
  const prefix = temporaryPartition(profile, "");
  return partition.startsWith(prefix) && CONVERSATION_ID.test(partition.slice(prefix.length));
};

export const profileFromArgv = (argv: readonly string[]) => {
  const flag = argv.find((argument) => argument.startsWith(`${BROWSER_PROFILE_ARGUMENT}=`));
  const profile = flag?.slice(BROWSER_PROFILE_ARGUMENT.length + 1);
  return profile && /^[0-9a-f]{16}$/.test(profile) ? profile : null;
};
