import { BadRequestException } from "@nestjs/common";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { tr } from "../../i18n/translate";
import { publicOnlyLookup } from "../../ai/providers/provider-egress";
import {
  isAllowlistedPrivateHostPort,
  parsePrivateHostAllowlist,
  PrivateBaseUrlAllowlist,
} from "../../ai/validators/private-base-url-allowlist";
import {
  isPrivateIp,
  unbracketHost,
  validateUrlIsSafe,
} from "../../ai/validators/safe-url.validator";

/**
 * Where a user's mailbox connection may go (INV-RECEIPT-004).
 *
 * A mailbox host is a host this server connects to on a user's behalf, so it is
 * held to the same rule as an AI provider's base URL, decided per owner:
 *
 * - an admin may reach any address;
 * - anyone else reaches public addresses only, unless the operator put the host
 *   (or `host:port`) on `EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST`.
 *
 * The decision is enforced twice, because each one alone has a gap: at save time
 * the host is checked as written and as it resolves now, and at connect time the
 * socket's own DNS lookup refuses a private answer (`publicOnlyLookup`), so the
 * address checked is the address connected to and a rebinding name has no
 * window. An IP literal skips the lookup, so it is refused before connecting.
 */
export interface MailboxHostPolicy {
  /** True when a private, loopback or link-local address may be connected to. */
  readonly allowPrivate: boolean;
  readonly reason: "admin" | "allowlisted" | "public-only";
}

/** The operator's allowlist, read from `EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST`. */
export function emailReceiptsPrivateHostAllowlist(): PrivateBaseUrlAllowlist {
  return parsePrivateHostAllowlist(
    process.env.EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST,
  );
}

/** Which addresses this owner's mailbox host may resolve to. */
export function resolveMailboxHostPolicy(input: {
  host: string;
  port: number;
  ownerIsAdmin: boolean;
  allowlist?: PrivateBaseUrlAllowlist;
}): MailboxHostPolicy {
  if (input.ownerIsAdmin) return { allowPrivate: true, reason: "admin" };
  const allowlist = input.allowlist ?? emailReceiptsPrivateHostAllowlist();
  if (isAllowlistedPrivateHostPort(input.host, input.port, allowlist)) {
    return { allowPrivate: true, reason: "allowlisted" };
  }
  return { allowPrivate: false, reason: "public-only" };
}

/** The refusal for a mailbox host that is not a public address. */
export function privateHostRefusal(): BadRequestException {
  return new BadRequestException(
    tr(
      "errors.emailReceipts.privateHostRefused",
      "This mail server address is a private or local network address (such as localhost, 192.168.x.x or a container name). Only an administrator can use one, unless the server operator allows that host in EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST.",
    ),
  );
}

/**
 * Whether a host, as written, is an IP literal for a private address. The URL
 * parser rewrites the decimal, hex and octal spellings to dotted form first, so
 * `2130706433` and `0x7f.1` are read as the loopback they are.
 */
export function isPrivateIpLiteral(host: string): boolean {
  const bare = unbracketHost(host.trim().toLowerCase());
  const bracketed = isIP(bare) === 6 ? `[${bare}]` : bare;
  let normalized: string;
  try {
    normalized = unbracketHost(new URL(`http://${bracketed}/`).hostname);
  } catch {
    return false;
  }
  return isIP(normalized) !== 0 && isPrivateIp(normalized);
}

/** The URL form of a host and port, for the shared URL safety check. */
function asCheckUrl(host: string, port: number): string {
  const bare = unbracketHost(host.trim().toLowerCase());
  return `https://${isIP(bare) === 6 ? `[${bare}]` : bare}:${port}/`;
}

/**
 * The save-time check. Returns the policy the host is then used under, and
 * refuses with `privateHostRefused` a host a non-admin may not reach: a private
 * IP literal, a blocked name (localhost, `.internal`, `.local`, the cloud
 * metadata names) or a name that resolves to any private address. The lookup is
 * bounded, and a name that did not answer in time is not established as public.
 */
export async function assertMailboxHostAllowed(input: {
  host: string;
  port: number;
  ownerIsAdmin: boolean;
  allowlist?: PrivateBaseUrlAllowlist;
}): Promise<MailboxHostPolicy> {
  const policy = resolveMailboxHostPolicy(input);
  if (policy.allowPrivate) return policy;
  if (
    isPrivateIpLiteral(input.host) ||
    !(await validateUrlIsSafe(asCheckUrl(input.host, input.port)))
  ) {
    throw privateHostRefusal();
  }
  return policy;
}

/**
 * The connect-time half: refuse a private IP literal before opening a socket
 * (it would never reach the lookup). A name is checked by the lookup itself.
 */
export function assertMailboxHostLiteralAllowed(
  host: string,
  policy: Pick<MailboxHostPolicy, "allowPrivate">,
): void {
  if (!policy.allowPrivate && isPrivateIpLiteral(host)) {
    throw privateHostRefusal();
  }
}

/**
 * The socket's DNS lookup for a policy: the public-only one, which refuses the
 * connection when ANY answer is private, unless the policy allows private (then
 * Node's own resolver is used, as for any connection).
 */
export function mailboxEgressLookup(
  policy: Pick<MailboxHostPolicy, "allowPrivate">,
): LookupFunction | undefined {
  return policy.allowPrivate ? undefined : publicOnlyLookup;
}
