/**
 * Which conversations have been seen untitled, and which have already played
 * their reveal. Owned by the mounted sidebar rather than by a row (so it
 * survives refetches and reordering) and never module-global, which on the
 * server would be shared across users.
 */
export interface TitleRevealRegistry {
  readonly pending: Set<string>;
  readonly revealed: Set<string>;
}

export const createTitleRevealRegistry = (): TitleRevealRegistry => ({
  pending: new Set(),
  revealed: new Set(),
});
