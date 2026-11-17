import { BlockList, isIPv6 } from "net";
import { NetworkInterfaceInfo, networkInterfaces } from "os";

import { localName } from "./names";
import {
  blockListOf,
  familyOf,
  inRanges,
  isPrivateAddress,
  LINK_LOCAL_RANGES,
  PRIVATE_RANGES,
  unmapAddress,
} from "./ranges";
import { SubjectNames } from "./x509";

/**
 * This PC's addresses as local-network access sees them
 * (docs/future-plans/desktop-lan-access.md, L5, L8 and L10).
 */

export type InterfaceTable = Readonly<
  Record<string, readonly NetworkInterfaceInfo[] | undefined>
>;

export interface LocalAddress {
  /** The adapter's name, as Windows shows it ("Wi-Fi", "Ethernet"). */
  readonly adapter: string;
  readonly address: string;
  readonly family: 4 | 6;
  /** `192.168.1.23/24`: the subnet the adapter is on. */
  readonly cidr: string;
}

export function systemInterfaces(): InterfaceTable {
  return networkInterfaces();
}

function external(table: InterfaceTable): LocalAddress[] {
  const out: LocalAddress[] = [];
  for (const [adapter, entries] of Object.entries(table)) {
    for (const entry of entries ?? []) {
      const family = familyOf(entry.address);
      if (entry.internal || family === null || entry.cidr === null) continue;
      out.push({
        adapter,
        address: entry.address.replace(/%.*$/, ""),
        family,
        cidr: entry.cidr,
      });
    }
  }
  return out;
}

/**
 * The addresses a device can be told to use: private IPv4 and IPv6
 * unique-local, never link-local (an IPv6 link-local address needs a zone a
 * browser's address bar cannot carry) and never a public address.
 */
export function servedAddresses(
  table: InterfaceTable,
): readonly LocalAddress[] {
  return external(table)
    .filter((entry) => isPrivateAddress(entry.address))
    .map((entry, index) => ({ entry, index, rank: rankOf(entry) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ entry }) => entry);
}

/** Adapters a phone is never on: WSL, Hyper-V, Docker and virtual machines. */
const VIRTUAL_ADAPTER = /vethernet|wsl|hyper-v|docker|virtualbox|vmware|vbox/i;

/**
 * Best first: the home network's usual ranges before the ones virtual
 * adapters take, IPv4 before IPv6, so the first address the setup window
 * shows is one a phone can reach.
 */
function rankOf(entry: LocalAddress): number {
  const virtual = VIRTUAL_ADAPTER.test(entry.adapter) ? 10 : 0;
  if (entry.address.startsWith("192.168.")) return virtual + 0;
  if (entry.address.startsWith("10.")) return virtual + 1;
  if (entry.family === 4) return virtual + 2;
  return virtual + 3;
}

/** Every subnet this PC has an adapter on, private or not. */
export function onLinkSubnets(table: InterfaceTable): BlockList {
  const list = new BlockList();
  for (const entry of external(table)) {
    const [network, prefix] = entry.cidr.split("/");
    list.addSubnet(
      network as string,
      Number(prefix),
      entry.family === 4 ? "ipv4" : "ipv6",
    );
  }
  return list;
}

const ACCEPTED_RANGES = blockListOf([...PRIVATE_RANGES, ...LINK_LOCAL_RANGES]);

/**
 * L10: a peer the LAN listener talks to. A private, link-local or loopback
 * address, or any address on a subnet this PC is itself on, which covers a
 * home network's global IPv6 prefix. A connection from anywhere else, which
 * only a port forwarded on the router could bring here, is closed.
 */
export function isAllowedPeer(address: string, table: InterfaceTable): boolean {
  const bare = unmapAddress(address);
  return (
    inRanges(bare, ACCEPTED_RANGES) || inRanges(bare, onLinkSubnets(table))
  );
}

/** What the server certificate must name (L5). */
export function servedNames(options: {
  readonly mdnsLabel: string | null;
  readonly computerLabel: string | null;
  readonly addresses: readonly LocalAddress[];
}): SubjectNames {
  const dns = [options.mdnsLabel, options.computerLabel]
    .filter((label): label is string => label !== null)
    .map(localName);
  return {
    dns: [...new Set(dns)],
    ip: [...new Set(options.addresses.map((entry) => entry.address))],
  };
}

/** `monize.local:3382`, `192.168.1.23:3382`, `[fd12::23]:3382`. */
export function hostValue(name: string, port: number): string {
  return `${isIPv6(name) ? `[${name}]` : name}:${port}`.toLowerCase();
}

/** The `Host` values the listener accepts (L9), for the names it serves. */
export function allowedHosts(
  names: SubjectNames,
  port: number,
): ReadonlySet<string> {
  return new Set(
    [...names.dns, ...names.ip].map((name) => hostValue(name, port)),
  );
}

/** The addresses a person can type, best first: the mDNS name, then the rest. */
export function addressUrls(
  names: SubjectNames,
  port: number,
): readonly string[] {
  return [...names.dns, ...names.ip].map(
    (name) => `https://${hostValue(name, port)}`,
  );
}
