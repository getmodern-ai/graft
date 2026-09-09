/**
 * Whether a hostname may be the target of a credential-bearing request — the address rule GRA-1
 * states for the proxy ("refuses private, link-local and cloud-metadata ranges at registration
 * and at resolution"), in one place because it is applied more than once: at registration, on the
 * hosts a person confirms on the handoff page, and again by the proxy at resolution — on the
 * literal before the fetch (`app.ts`) and on the address the hostname actually resolved to, inside
 * the resolver the socket is opened through (`upstream.ts`). Two copies of a range list drift, and
 * a range missing from one side is a request to the cloud metadata service with a person's key on
 * it. It lives in this package rather than in the host because the proxy may import nothing from
 * the host (`index.ts`), while the host may import from here.
 *
 * Total functions over strings. No DNS here, deliberately: a name is judged on what it *says*,
 * and what it *resolves to* is a fact only the process about to connect can check.
 */

/** `[::1]` as a URL hostname carries its brackets; an address does not. */
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Four decimal octets, or null. A leading zero (`010.0.0.1`) is refused rather than read: it is
 * octal to some resolvers and decimal to others, and both the URL parser and DNS hand over the
 * canonical spelling, so anything else is not an address a request could carry.
 */
function parseIpv4(host: string): number[] | null {
  const match = IPV4.exec(host);
  if (!match) return null;
  const text = match.slice(1);
  if (text.some((octet) => octet.length > 1 && octet.startsWith("0"))) return null;
  const octets = text.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/**
 * The IPv4 ranges a credential must never be sent to. Private (RFC 1918), loopback, link-local —
 * which is where every cloud metadata service lives, `169.254.169.254` included — plus the
 * unspecified, carrier-NAT, documentation, benchmarking, 6to4-relay, multicast and reserved
 * blocks, none of which a vendor's public API can be behind.
 */
function isForbiddenIpv4([a, b, c]: number[]): boolean {
  if (a === undefined || b === undefined || c === undefined) return true;
  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — carrier NAT
  if (a === 127) return true; // 127.0.0.0/8 — loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local, and the metadata service
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 and 192.0.2.0/24 — IETF, documentation
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 — 6to4 relay anycast, deprecated
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmarking
  if (a === 198 && b === 51) return true; // 198.51.100.0/24 — documentation
  if (a === 203 && b === 0) return true; // 203.0.113.0/24 — documentation
  if (a >= 224) return true; // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, broadcast
  return false;
}

/**
 * Eight 16-bit groups, or null when the text is not an IPv6 address. Handles the one `::` gap and
 * a dotted IPv4 tail (`::ffff:10.0.0.1`), which is how a mapped address is typed even though the
 * URL parser serialises it back to hex groups. A zone id (`fe80::1%eth0`) is not an address this
 * reads: it marks a scoped address — link-local or multicast — which no range below admits anyway,
 * so refusing the text is the same verdict reached sooner.
 */
function parseIpv6(host: string): number[] | null {
  if (!host.includes(":")) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (text: string): number[] | null => {
    if (text === "") return [];
    const parts = text.split(":");
    const groups: number[] = [];
    for (const [index, part] of parts.entries()) {
      // A dotted quad may only close the address, standing in for the last two groups.
      if (part.includes(".")) {
        if (index !== parts.length - 1) return null;
        const v4 = parseIpv4(part);
        if (!v4) return null;
        const [a, b, c, d] = v4 as [number, number, number, number];
        groups.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (!head || !tail) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const gap = 8 - head.length - tail.length;
  if (gap < 1) return null;
  return [...head, ...new Array<number>(gap).fill(0), ...tail];
}

/**
 * The IPv6 counterparts: `::/96` (unspecified, loopback and the deprecated IPv4-compatible form),
 * unique-local (`fc00::/7`), link-local (`fe80::/10` — the metadata service again, as
 * `fd00:ec2::254`'s neighbours), the deprecated site-local block (`fec0::/10`), the discard prefix
 * (`100::/64`), local-use NAT64 (`64:ff9b:1::/48`), documentation and multicast, plus the two forms
 * that smuggle an IPv4 address through — mapped (`::ffff:a.b.c.d`) and NAT64 (`64:ff9b::/96`) —
 * which are judged by the address they carry.
 */
function isForbiddenIpv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const leadingZeros = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  if (leadingZeros && g5 === 0) return true; // ::/96 — ::, ::1 and ::a.b.c.d
  if (leadingZeros && g5 === 0xffff) return isForbiddenIpv4(embedded(g6, g7)); // ::ffff:a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isForbiddenIpv4(embedded(g6, g7)); // 64:ff9b::a.b.c.d — NAT64
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // 64:ff9b:1::/48 — local-use NAT64
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 — discard-only
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 — unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 — link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 — site-local, deprecated but still "here"
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 — multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 — documentation
  return false;
}

/** The verdict on an IP literal of either family, or null when the text is not one. */
function judgeAddress(host: string): boolean | null {
  const v4 = parseIpv4(host);
  if (v4) return !isForbiddenIpv4(v4);

  const v6 = parseIpv6(host);
  if (v6) return !isForbiddenIpv6(v6);

  return null;
}

/**
 * True when `address` — bare or bracketed — is an IP literal in a range a credential may be sent
 * to. Anything that is not an address is refused, a public name included: this is the question
 * asked of what a name *resolved to*, where a non-address is an error and not something to look up.
 */
export function isPublicAddress(address: string): boolean {
  return judgeAddress(stripBrackets(address.trim().toLowerCase())) ?? false;
}

/**
 * Names that are internal by construction, whatever they resolve to. `.internal` is where GCP and
 * AWS put their metadata and VPC names, `.local` is mDNS, `.localhost` and `.home.arpa` are
 * reserved for exactly this. A single-label name (`intranet`, `db`) has no public DNS meaning
 * either — every public API has at least a registered domain under it.
 */
const INTERNAL_SUFFIXES = [".internal", ".local", ".localhost", ".home.arpa"];

/**
 * True when `hostname` — as `new URL(...).hostname` gives it, or as a bare address — names
 * something a credential may be sent to. An IP literal is judged by its range; a name by whether
 * it is a public DNS name at all. A public *name* can still resolve privately, which is why the
 * proxy asks this question again about the resolved address (`upstream.ts`).
 */
export function isPublicHost(hostname: string): boolean {
  const host = stripBrackets(hostname.trim().toLowerCase());
  if (host === "") return false;

  const literal = judgeAddress(host);
  if (literal !== null) return literal;

  if (host === "localhost") return false;
  if (INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  if (!host.includes(".")) return false;
  // A trailing dot is a fully-qualified spelling of the same name; anything else odd in a
  // hostname (`..`, a leading dot) is not a name a vendor publishes.
  const labels = host.replace(/\.$/, "").split(".");
  // A top-level label is never all digits (RFC 3696), so a dotted string that failed to parse as
  // an IPv4 address — `999.1.1.1`, `1.2.3.4.5` — is a malformed address, not a name, and is
  // refused as one rather than waved through as a hostname.
  if (/^\d+$/.test(labels.at(-1) ?? "")) return false;
  return labels.every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label));
}
