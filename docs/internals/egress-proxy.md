# Egress proxy

`@chat/egress-proxy` is the only way a chat's VM reaches the network. microsandbox hands every TCP
connection the guest makes to this proxy as an HTTP CONNECT, and the guest's DNS goes to a
listener of the proxy's. The proxy decides each connection. It knows nothing about chats, VMs or
Electron: the desktop gives it a context per client and a `decide` callback, and it reports
denials back.

## A client is one VM

- `issue(context)` mints a token and starts that client's name listener. The VM is configured with
  the token as its CONNECT password (username `vm`), held by microsandbox on the host and never
  visible to the guest, and with the listener as its only DNS server.
- Every CONNECT must present the token. The context it was issued with goes to `decide` and to
  every denial, so a chat's grants apply to its own VM and a denial reaches that chat.
- `revoke` ends the token, closes the name listener and closes every tunnel the client opened.

## Names, not addresses

- The name listener resolves nothing. It answers each A query with a placeholder from
  198.18.0.0/15 (RFC 2544 benchmarking, never routed), unique to that name within the client and
  stable for its life. AAAA and every other type answer empty.
- A CONNECT to a placeholder is the connection to its name, and from there it is decided exactly
  like `CONNECT name:port`. A placeholder this client was never handed is refused without asking
  `decide`.
- This is why nothing else is needed:
  - lookups cannot carry data out, since nothing is resolved until a grant allows a connection
  - a connection names exactly one host, so a CDN address shared by many names is never
    ambiguous
  - nothing in the guest needs proxy settings: Java, ssh and git connect normally
- A connection to an address the guest did not get from DNS (an IP literal) is decided as that
  address.

## Destinations the host serves itself

`local` may answer an allowed destination with a connector of its own instead of a dial, for a
service on this computer. `decide` still rules first, so a grant id revokes it like any tunnel. The
address guard does not apply, since nothing is resolved.

## One spelling, decided once, dialled as decided

- A host is validated, then canonicalized (lowercase, one trailing dot removed, every IPv4 and
  IPv6 spelling normalized). The canonical form is what `decide` sees and what is dialled.
  Anything that does not canonicalize is refused, never passed through raw.
- A grant names `host:port` and must carry a `grantId`. `regrant` closes the tunnels a removed
  grant allowed unless another grant still covers them. A grant is decided once, at establishment.
- DNS is resolved by the proxy, once, and the connection goes to an address that passed the guard,
  so a changing answer cannot redirect it.
  - Lookups use the system resolver, so VPN, split DNS and the hosts file behave as they do for
    every other program. c-ares reads the server list directly and waited out dead servers the
    system skips.
  - They are fully qualified (no search domains), and at most two run at once: getaddrinfo holds
    a libuv pool thread for the whole lookup and the pool has four.
- The addresses are tried in turn. While another remains, each attempt gets `attemptMs` (five
  seconds), so a silent address (an unreachable IPv6 route) cannot spend the whole establishment
  deadline. The last keeps what is left of it.

## The address guard has no exceptions

- **Always refused,** for every name and literal, whatever the grant: loopback, link-local,
  multicast, cloud metadata endpoints and the machine's own interface addresses.
- **Private networks** are refused unless the grant is a private-network grant for that
  `host:port`.
- **IPv4 carried inside IPv6** (mapped, NAT64, 6to4, Teredo) is judged as IPv4.
- **If the machine's addresses can't be listed,** the connection fails closed.
- **The server's own fetches** (`url-safety.ts`) judge addresses with this same guard, with no
  grant and no interfaces, so the two ways out cannot disagree.

## What it does not do

- **Only TCP.** The VM's network policy allows UDP only to its DNS, so there is no QUIC and no
  other UDP. A tunnel is an opaque TCP stream: a grant for `:22` allows any protocol to that
  endpoint.
- **How a refusal looks:** a `403` with `x-egress-denied: 1`, which the guest sees as a refused
  connection. A network failure is a `502`.
  - When a candidate was skipped by policy and nothing else got through, the answer is the
    denial.
  - A reported denial says what would `lift` it:
    - a grant, when `decide` refused
    - a private-network grant, when the address guard refused a private address among them (one
      usable address is enough)
    - nothing, for a destination it would refuse whatever a grant allowed: loopback, `localhost`,
      `.invalid`, an unknown placeholder

    So a caller can tell "ask for a grant" from a refusal no grant changes.
