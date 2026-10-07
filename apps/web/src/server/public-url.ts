/**
 * The address people reach this instance at, without a trailing slash. Unset
 * when nothing is in front of the server, in which case a request's own
 * origin is the best answer there is.
 */
export const publicUrl = () => process.env.PUBLIC_URL?.replace(/\/+$/, "") || undefined;
