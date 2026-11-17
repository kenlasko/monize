import { BlockList, isIPv4, isIPv6 } from "net";

/**
 * The address ranges local-network access works with
 * (docs/future-plans/desktop-lan-access.md, L4, L5 and L10), written once.
 */

export interface IpRange {
  readonly address: string;
  readonly prefix: number;
  readonly family: 4 | 6;
}

/** RFC 1918 and IPv6 unique-local: where a home network's addresses are. */
export const PRIVATE_RANGES: readonly IpRange[] = [
  { address: "10.0.0.0", prefix: 8, family: 4 },
  { address: "172.16.0.0", prefix: 12, family: 4 },
  { address: "192.168.0.0", prefix: 16, family: 4 },
  { address: "fc00::", prefix: 7, family: 6 },
];

/**
 * The shared address space (RFC 6598) that Tailscale and some carriers use.
 * The root certificate permits it from the start (section 13 of the plan), so
 * that serving a Tailscale address later needs no device to trust a new root;
 * the listener does not accept peers from it (open question 2).
 */
export const SHARED_RANGE: IpRange = {
  address: "100.64.0.0",
  prefix: 10,
  family: 4,
};

/** What the root's Name Constraints permit for IP addresses. */
export const CONSTRAINED_RANGES: readonly IpRange[] = [
  ...PRIVATE_RANGES,
  SHARED_RANGE,
];

/** Link-local and loopback: peers the listener accepts but never names. */
export const LINK_LOCAL_RANGES: readonly IpRange[] = [
  { address: "169.254.0.0", prefix: 16, family: 4 },
  { address: "fe80::", prefix: 10, family: 6 },
  { address: "127.0.0.0", prefix: 8, family: 4 },
  { address: "::1", prefix: 128, family: 6 },
];

export function blockListOf(ranges: readonly IpRange[]): BlockList {
  const list = new BlockList();
  for (const range of ranges) {
    list.addSubnet(
      range.address,
      range.prefix,
      range.family === 4 ? "ipv4" : "ipv6",
    );
  }
  return list;
}

/** `::ffff:192.168.1.2` (a dual-stack socket's view of IPv4) as `192.168.1.2`. */
export function unmapAddress(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? (mapped[1] as string) : address.replace(/%.*$/, "");
}

export function familyOf(address: string): 4 | 6 | null {
  if (isIPv4(address)) return 4;
  if (isIPv6(address)) return 6;
  return null;
}

export function inRanges(address: string, list: BlockList): boolean {
  const bare = unmapAddress(address);
  const family = familyOf(bare);
  return family !== null && list.check(bare, family === 4 ? "ipv4" : "ipv6");
}

const PRIVATE_LIST = blockListOf(PRIVATE_RANGES);

/** True for an address a home network hands out (and the certificate may name). */
export function isPrivateAddress(address: string): boolean {
  return inRanges(address, PRIVATE_LIST);
}
