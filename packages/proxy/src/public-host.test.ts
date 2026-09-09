import { describe, expect, it } from "vitest";

import { isPublicAddress, isPublicHost } from "./public-host";

/**
 * The proxy's address rule, as a matrix. Each refusal here is an address a credential would
 * otherwise be sent to by the proxy — the private ranges, the loopbacks, the link-local block
 * every cloud metadata service lives in, and the names that are internal by construction.
 */
describe("isPublicHost", () => {
  it.each([
    "api.unleashedsoftware.com",
    "api.cartoncloud.com.au",
    "example.org.",
    "93.184.216.34",
    "8.8.8.8",
    "[2606:4700:4700::1111]",
    "2606:4700:4700::1111",
    "xn--bcher-kva.example",
  ])("accepts a public host: %s", (host) => {
    expect(isPublicHost(host)).toBe(true);
  });

  it.each([
    ["10.0.0.1", "RFC 1918 10/8"],
    ["10.255.255.255", "RFC 1918 10/8 upper edge"],
    ["172.16.0.1", "RFC 1918 172.16/12"],
    ["172.31.255.254", "RFC 1918 172.16/12 upper edge"],
    ["192.168.1.1", "RFC 1918 192.168/16"],
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback, any address in 127/8"],
    ["0.0.0.0", "unspecified"],
    ["169.254.169.254", "the cloud metadata service"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "carrier NAT"],
    ["192.0.0.1", "IETF protocol assignments"],
    ["192.0.2.1", "documentation"],
    ["198.18.0.1", "benchmarking"],
    ["198.51.100.1", "documentation"],
    ["203.0.113.1", "documentation"],
    ["192.88.99.1", "6to4 relay anycast, deprecated"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
  ])("refuses %s (%s)", (host) => {
    expect(isPublicHost(host)).toBe(false);
  });

  it.each([
    ["[::1]", "loopback, bracketed as a URL hostname"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["[fd00:ec2::254]", "unique local — the IPv6 metadata service"],
    ["fc00::1", "unique local"],
    ["fe80::1", "link-local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["::ffff:10.0.0.1", "IPv4-mapped, private inside"],
    ["::ffff:a00:1", "IPv4-mapped in the hex form the URL parser serialises to"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata service"],
    ["64:ff9b::127.0.0.1", "NAT64 loopback"],
    ["64:ff9b:1::1", "local-use NAT64"],
    ["::10.0.0.1", "IPv4-compatible, deprecated"],
    ["fec0::1", "site-local, deprecated"],
    ["100::1", "discard-only"],
    ["fe80::1%eth0", "link-local with a zone id"],
  ])("refuses %s (%s)", (host) => {
    expect(isPublicHost(host)).toBe(false);
  });

  it("judges a mapped or NAT64 address by what it carries, so a public one passes", () => {
    expect(isPublicHost("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicHost("64:ff9b::8.8.8.8")).toBe(true);
  });

  it.each([
    "2606:2800:220:1:248:1893:25c8:1946",
    "2001:4860:4860::8888",
    "172.32.0.1",
    "192.169.0.1",
  ])("accepts a public address next to a refused range: %s", (host) => {
    expect(isPublicHost(host)).toBe(true);
  });

  it.each([
    ["localhost", "loopback by name"],
    ["LOCALHOST", "case is not a disguise"],
    ["api.localhost", "the reserved TLD"],
    ["db.internal", "cloud-internal names"],
    ["metadata.google.internal", "GCP's metadata service"],
    ["printer.local", "mDNS"],
    ["router.home.arpa", "home networks"],
    ["intranet", "a single-label name has no public meaning"],
    ["", "nothing"],
    [" ", "whitespace"],
    [".example.com", "a leading dot"],
    ["exa mple.com", "a space inside a label"],
    ["-bad.example.com", "a label starting with a hyphen"],
  ])("refuses %s (%s)", (host) => {
    expect(isPublicHost(host)).toBe(false);
  });

  it("rejects malformed address literals rather than guessing", () => {
    expect(isPublicHost("1.2.3.4.5")).toBe(false);
    expect(isPublicHost("1:2:3:4:5:6:7:8:9")).toBe(false);
    expect(isPublicHost("1:2:3:4:5:6:7")).toBe(false);
    expect(isPublicHost("1::2::3")).toBe(false);
    expect(isPublicHost("999.1.1.1")).toBe(false);
    expect(isPublicHost("01.2.3.4")).toBe(false);
  });
});

/**
 * The address half on its own — what a resolver's answers are judged by (`upstream.ts`). A name is
 * not an address here, however public.
 */
describe("isPublicAddress", () => {
  it("judges a literal by its range, bracketed or bare", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("[2606:4700:4700::1111]")).toBe(true);
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:169.254.169.254")).toBe(false);
  });

  it("refuses anything that is not an address, a public name included", () => {
    expect(isPublicAddress("api.unleashedsoftware.com")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });
});
