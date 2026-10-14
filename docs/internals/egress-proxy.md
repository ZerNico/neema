# Egress proxy

`@chat/egress-proxy` is the only way a sandboxed command reaches the network. The sandbox lets a
command connect to one loopback address, this proxy, and the proxy decides each HTTPS tunnel. It
knows nothing about chats, sandboxes or Electron: the desktop gives it a token per command and a
`decide` callback, and it reports denials back.

## Identity is a token per command

- Each command gets its own token, minted by `issue` and carried as the password in its proxy URL.
  Every CONNECT must present it. The token names the server, chat, attempt and command, so the
  callback can apply that chat's grants and a denial reaches the chat that caused it.
- `issuePort` mints a token and a listener of the command's own that asks for no credentials,
  for a sandbox that reaches that one port alone and refuses a URL carrying them (bubblewrap).
  Only there is a port a credential: where commands share loopback, one could dial another's.
- `revoke` ends a token when its command ends and closes every tunnel it opened, and its own
  listener if it has one. A command can read
  its own token and pass it to a process that can reach the proxy; it is only good while the
  command runs.
- Loopback authenticates nothing. On Windows any local process can reach the listener, so every
  request is refused until it authenticates, and connections that have not authenticated are
  capped and dropped after `headerMs`. A local process can still hold those slots by reopening
  idle sockets; that is accepted.

## Destinations the host serves itself

- `local` may answer an allowed destination with a connector of its own instead of a dial: the
  desktop serves the SSH agent's pipe this way on Windows. `decide` still rules first, so a grant
  id revokes it like any tunnel; the address guard does not apply, since nothing is resolved.

## One spelling, decided once, dialled as decided

- A host is validated, then canonicalized (lowercase, one trailing dot removed, every IPv4 and
  IPv6 spelling normalized), and the canonical form is what `decide` sees and what is dialled.
  Anything that does not canonicalize is refused, never passed through raw.
- A grant names `host:port` and must carry a `grantId`. `regrant` closes the tunnels a removed
  grant allowed unless another grant still covers them. A grant is decided once, at establishment.
- DNS is resolved once and the connection goes to an address that passed the guard, so a changing
  answer cannot redirect it. Lookups use the system resolver, so VPN, split DNS and the hosts
  file behave as they do for every other program; c-ares reads the server list directly and
  waited out dead servers the system skips. They are fully qualified (no search domains, so a
  bare `git` does not resolve), and at most two run at once: getaddrinfo holds a libuv pool
  thread for the whole lookup and the pool has four.
- The addresses are tried in turn. While another remains, each attempt gets `attemptMs` (five
  seconds), so a silent address (an unreachable IPv6 route) cannot spend the whole establishment
  deadline; the last keeps what is left of it.

## The address guard has no exceptions

Loopback, link-local, multicast, cloud metadata endpoints and the machine's own interface
addresses are refused for every name and literal, whatever the grant. Private networks are refused
unless the grant is a private-network grant for that `host:port`. IPv4 carried inside IPv6
(mapped, NAT64, 6to4) is judged as IPv4. If the machine's addresses cannot be listed, the
connection fails closed.

## What it does not do

- Only CONNECT. Plain HTTP is refused, and a tunnel is an opaque TCP stream: a grant for `:22`
  allows any protocol to that endpoint.
- Tools that do not use an HTTP proxy cannot reach the network at all. Java ignores the proxy
  variables, so Gradle and Maven get their own proxy settings from the desktop.
- A denial is a `403` with `x-egress-denied: 1`; a network failure is a `502`. When a candidate was
  skipped by policy and nothing else got through, the answer is the denial.
