import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import * as dns from "dns";
import * as net from "net";
import {
  AiProviderType,
  SELF_HOSTED_PROVIDERS,
} from "../entities/ai-provider-config.entity";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "169.254.169.254",
  "metadata",
]);

const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost"];

/**
 * How long the safety check's DNS lookup may take before the answer is "not
 * established".
 *
 * `dns.resolve4`/`resolve6` carry no timeout of their own, so a name whose
 * authoritative nameserver never answers holds the caller for c-ares' whole
 * retry budget -- tens of seconds, on a request path, chosen by whoever supplied
 * the URL. A lookup that has not answered in this long has not established the
 * host is public, and an unestablished host is not one this server connects to,
 * so the timeout answers `false` rather than "probably fine".
 *
 * Five seconds, not two, and the difference is a decision. Bounding the lookup
 * turned a slow resolver from "allow, the HTTP request will fail" into a
 * rejection, for every caller -- including an operator saving a perfectly valid
 * `api.anthropic.com` behind an intermittent resolver, who would be told their
 * URL was the problem. A save can wait five seconds; the push sender's per-send
 * re-check cannot, and it passes its own tighter bound through
 * `validateUrlIsSafeWithin` because its budget is part of a documented request
 * worst case.
 */
export const URL_SAFETY_CHECK_TIMEOUT_MS = 5_000;

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  // 100.64.0.0/10 shared address space (CGNAT, Tailscale) and 198.18.0.0/15 benchmarking.
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^198\.1[89]\./,
];

/**
 * The IPv6 blocks this server must not connect to, as the masks that define
 * them.
 *
 * Spelled as text prefixes, they were wrong for most of the space they claimed:
 * `/^fc00:/` and `/^fd/` covered `fc00::` and every `fd..`, and left `fc01::1`
 * through `fcff::1` -- most of unique-local fc00::/7 -- reading as public.
 * `/^fe80:/` left `fe90::` to `febf::`, most of link-local fe80::/10. Both were
 * reachable through a client-supplied URL this server then POSTs to.
 *
 * A CIDR block is a mask over the first 16 bits, so that is what the check is.
 * `fec0::/10` is deprecated site-local and blocked for the same reason; `ff00::/8`
 * is multicast, which is not a host to make an HTTP request to at all.
 *
 * Deliberately absent, as elsewhere in this file: 6to4 (`2002::/16`) and Teredo
 * (`2001::/32`), which embed an IPv4 address but reach it only through a relay
 * this server would have to be configured to use.
 */
const PRIVATE_IPV6_BLOCKS: ReadonlyArray<{
  mask: number;
  value: number;
  block: string;
}> = [
  { mask: 0xfe00, value: 0xfc00, block: "fc00::/7 unique-local" },
  { mask: 0xffc0, value: 0xfe80, block: "fe80::/10 link-local" },
  { mask: 0xffc0, value: 0xfec0, block: "fec0::/10 site-local (deprecated)" },
  { mask: 0xff00, value: 0xff00, block: "ff00::/8 multicast" },
];

/** Loopback, the unspecified address, and the blocks above. */
function isPrivateIpv6(hostname: string): boolean {
  const groups = expandIpv6(hostname);
  if (!groups) return false;
  // `::` -- unspecified, which a connect() reads as localhost.
  if (groups.every((group) => group === 0)) return true;
  // `::1` -- loopback.
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return true;
  }
  return PRIVATE_IPV6_BLOCKS.some(
    ({ mask, value }) => (groups[0] & mask) === value,
  );
}

/**
 * The host as an address-comparable string.
 *
 * `URL.hostname` keeps the brackets on an IPv6 literal (`https://[::1]/` yields
 * `"[::1]"`), and every check below compares against unbracketed forms:
 * `net.isIP("[::1]")` is 0, `normalizeIp` returns null, and `/^::1$/` does not
 * match. So a bracketed loopback or link-local address passed the whole strict
 * check -- an SSRF bypass on any client-supplied URL, found by the push
 * endpoint's own validator spec. Stripping the brackets once, where the hostname
 * is derived, is what makes the existing rules apply to IPv6 at all.
 */
export function unbracketHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * The IPv4 address an IPv6 literal carries, or null.
 *
 * An IPv6 address can embed an IPv4 one, and the private-address rules are
 * written in dotted decimal -- so an embedded form has to be mapped back before
 * it is tested, or it is compared against patterns that cannot match it. There
 * are more spellings than the obvious one, and the URL parser rewrites all of
 * them to hex: `https://[::ffff:127.0.0.1]/` arrives as `::ffff:7f00:1`,
 * `https://[::127.0.0.1]/` as `::7f00:1`, and `https://[::ffff:0:127.0.0.1]/`
 * as `::ffff:0:7f00:1`. A rule spelled per-spelling covers whichever ones its
 * author thought of: the first pass here handled `::ffff:` with a two-group
 * tail and left IPv4-compatible and IPv4-translated loopback ACCEPTED.
 *
 * So the address is expanded to its eight groups and the known embedding
 * prefixes are matched on the groups, not on the text:
 *
 * - the zero-prefixed forms: IPv4-compatible (`::a.b.c.d`), IPv4-mapped
 *   (`::ffff:a.b.c.d`) and the deprecated IPv4-translated `::ffff:0:a.b.c.d`,
 *   which differ only in where the `ffff` sits.
 * - `64:ff9b::/96` and `64:ff9b:1::/48` -- the NAT64 prefixes, whose whole
 *   purpose is that a gateway forwards them to the embedded IPv4 address.
 *
 * Deliberately not covered: 6to4 (`2002::/16`) and Teredo (`2001::/32`), which
 * also embed an IPv4 address but reach it only through a relay this server
 * would have to be configured to use. They are named here so the omission is a
 * decision rather than an oversight.
 */
function embeddedIpv4(hostname: string): string | null {
  if (!net.isIPv6(hostname)) return null;

  const groups = expandIpv6(hostname);
  if (!groups) return null;

  // The three zero-prefixed embeddings, written as what distinguishes them:
  // groups 0-3 are zero in all of them, and the pair (4, 5) is (0, 0) for
  // IPv4-compatible, (0, ffff) for IPv4-mapped and (ffff, 0) for the
  // IPv4-translated form. Anything else in that pair is an ordinary IPv6
  // address whose last 32 bits mean nothing in particular.
  const zeroPrefix =
    groups.slice(0, 4).every((g) => g === 0) &&
    ((groups[4] === 0 && (groups[5] === 0 || groups[5] === 0xffff)) ||
      (groups[4] === 0xffff && groups[5] === 0));
  const nat64 =
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    // 64:ff9b::/96 has zeros through group 5; 64:ff9b:1::/48 sets group 2 to 1.
    (groups[2] === 0 || groups[2] === 1) &&
    groups.slice(3, 6).every((g) => g === 0);
  if (!zeroPrefix && !nat64) return null;

  const high = groups[6];
  const low = groups[7];
  return [
    (high >>> 8) & 0xff,
    high & 0xff,
    (low >>> 8) & 0xff,
    low & 0xff,
  ].join(".");
}

/**
 * An IPv6 literal as eight numeric groups, `::` expanded and a dotted IPv4 tail
 * folded into the last two. Returns null for anything it cannot read, so a
 * caller never sees a partially parsed address.
 */
function expandIpv6(hostname: string): number[] | null {
  let text = hostname;

  // A dotted tail (`::ffff:127.0.0.1`) is two groups. Node's parser normally
  // rewrites it, but this function is also handed addresses from DNS answers.
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null;
    const octets = dotted[1].split(".").map((o) => parseInt(o, 10));
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, dotted.index)}:${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if (left === null || right === null) return null;

  if (halves.length === 1) return left.length === 8 ? left : null;
  const fill = 8 - left.length - right.length;
  if (fill < 1) return null;
  return [...left, ...new Array<number>(fill).fill(0), ...right];
}

/**
 * Normalize an IP address string to dotted-decimal (IPv4),
 * catching hex/octal/decimal encoded IPs that bypass regex-based checks.
 */
function normalizeIp(hostname: string): string | null {
  // An embedded IPv4 first, because such an address IS a valid IPv6 literal and
  // `net.isIP` below would return it unchanged for the IPv6 patterns to test --
  // which spell loopback and private space in dotted decimal. Mapping it back
  // is what puts it in front of the IPv4 rules that already cover it.
  const embedded = embeddedIpv4(hostname);
  if (embedded) return embedded;

  if (net.isIP(hostname)) return hostname;

  try {
    // Decimal IP: e.g. 2130706433 => 127.0.0.1
    if (/^\d{1,10}$/.test(hostname)) {
      const num = parseInt(hostname, 10);
      if (num >= 0 && num <= 0xffffffff) {
        return [
          (num >>> 24) & 0xff,
          (num >>> 16) & 0xff,
          (num >>> 8) & 0xff,
          num & 0xff,
        ].join(".");
      }
    }
    // Hex IP: e.g. 0x7f000001
    if (/^0x[0-9a-f]{1,8}$/i.test(hostname)) {
      const num = parseInt(hostname, 16);
      if (num >= 0 && num <= 0xffffffff) {
        return [
          (num >>> 24) & 0xff,
          (num >>> 16) & 0xff,
          (num >>> 8) & 0xff,
          num & 0xff,
        ].join(".");
      }
    }
    // Octal-dotted IP: e.g. 0177.0.0.1
    if (/^0\d+(\.\d+){0,3}$/.test(hostname)) {
      const parts = hostname.split(".");
      if (parts.length <= 4 && parts.every((p) => /^0?\d+$/.test(p))) {
        const octets = parts.map((p) =>
          p.startsWith("0") && p.length > 1 ? parseInt(p, 8) : parseInt(p, 10),
        );
        if (octets.every((o) => o >= 0 && o <= 255)) {
          return octets.join(".");
        }
      }
    }
  } catch {
    // Parsing failed, not a numeric IP
  }
  return null;
}

/**
 * Whether an address is one this server must not be sent to.
 *
 * The embedded-IPv4 mapping happens HERE rather than only at the hostname,
 * because this function is also handed the answers to a DNS lookup: a name with
 * an AAAA record of `::7f00:1` is the rebinding half of the same bypass, and it
 * never passes through `normalizeIp`.
 */
export function isPrivateIp(ip: string): boolean {
  const embedded = embeddedIpv4(ip);
  const candidates = embedded ? [ip, embedded] : [ip];
  for (const candidate of candidates) {
    for (const pattern of PRIVATE_IP_RANGES) {
      if (pattern.test(candidate)) return true;
    }
  }
  return isPrivateIpv6(ip);
}

function dnsResolve(hostname: string): Promise<string[]> {
  return new Promise((resolve) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (err || !addresses) return resolve([]);
      resolve(addresses);
    });
  });
}

function dnsResolve6(hostname: string): Promise<string[]> {
  return new Promise((resolve) => {
    dns.resolve6(hostname, (err, addresses) => {
      if (err || !addresses) return resolve([]);
      resolve(addresses);
    });
  });
}

/**
 * Both families, or `null` when the resolver did not answer in time.
 *
 * `null` is a third state on purpose: an empty list means "this name resolves to
 * nothing", which the caller allows, and a stalled resolver must not borrow that
 * answer. A rejection stays "allow" -- a name that genuinely does not resolve is
 * a request that will fail on its own -- but a name we simply did not wait long
 * enough to learn about is not established as safe.
 */
async function resolveBothFamilies(
  hostname: string,
  timeoutMs: number = URL_SAFETY_CHECK_TIMEOUT_MS,
): Promise<string[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all([dnsResolve(hostname), dnsResolve6(hostname)]).then(
        ([ipv4Addrs, ipv6Addrs]) => [...ipv4Addrs, ...ipv6Addrs],
      ),
      new Promise<null>((resolve) => {
        // Unreffed: a caller that bounds the WHOLE check (validateUrlIsSafeWithin)
        // abandons this race when its own deadline wins, and the abandoned timer
        // would then keep the event loop -- and a Jest worker -- alive for the
        // rest of its budget. A timer that exists only to bound a race must not
        // outlive interest in the answer.
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    // Neither lookup rejects (both resolve to [] on error), so this is defensive
    // only -- and it answers "resolved to nothing", the behaviour a failed
    // lookup has always had here.
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The half of the address check that needs no resolver: a blocked name or
 * suffix, or a private, loopback, link-local or metadata address in any
 * spelling (hex, decimal, octal, IPv6-mapped). Exported so a client that holds
 * the resolved address to the same rule at connect time (`publicOnlyLookup`)
 * can refuse the name up front without a second lookup, and can tell "this
 * address is not allowed" from "the resolver did not answer".
 */
export function isRefusedHostName(host: string): boolean {
  const hostname = unbracketHost(host.toLowerCase());
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;
  for (const suffix of BLOCKED_SUFFIXES) {
    if (hostname.endsWith(suffix) || hostname === suffix.slice(1)) return true;
  }
  // Check for alternative IP encodings (hex, decimal, octal, IPv6-mapped)
  const normalizedIp = normalizeIp(hostname);
  if (normalizedIp && isPrivateIp(normalizedIp)) return true;
  // The hostname as written, through the same decision. Two loops over the
  // same list is how the IPv6 half came to be missing from one of them: the
  // ranges were text prefixes here and nothing structural anywhere, so
  // `fc01::1` passed both.
  return isPrivateIp(hostname);
}

@ValidatorConstraint({ async: true })
export class IsSafeUrlConstraint implements ValidatorConstraintInterface {
  async validate(value: unknown): Promise<boolean> {
    if (typeof value !== "string") return false;

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    const hostname = unbracketHost(parsed.hostname.toLowerCase());

    if (isRefusedHostName(hostname)) {
      return false;
    }
    const normalizedIp = normalizeIp(hostname);

    if (parsed.username || parsed.password) {
      return false;
    }

    // DNS resolution check: resolve hostname and verify IPs are not private.
    //
    // Bounded HERE, so every caller is bounded -- `dns.resolve4`/`resolve6` carry
    // no timeout of their own, and a name delegated to a nameserver that never
    // answers held whichever request asked for the resolver's whole retry budget
    // (tens of seconds). A lookup that did not answer is NOT "no addresses":
    // empty means "resolved to nothing", which this code allows, so a timeout
    // has to reach the verdict as a refusal instead.
    if (!net.isIP(hostname) && !normalizedIp) {
      const allAddrs = await resolveBothFamilies(hostname);
      if (allAddrs === null) return false;
      // Reject if ANY resolved address is private (prevents DNS rebinding)
      if (allAddrs.length > 0 && allAddrs.some((ip) => isPrivateIp(ip))) {
        return false;
      }
    }

    return true;
  }

  defaultMessage(): string {
    return "baseUrl must be a valid HTTP/HTTPS URL pointing to an external host";
  }
}

/**
 * Standalone function to validate a URL is safe (not targeting private/internal IPs).
 * Can be used outside of class-validator context (e.g. validating env vars at startup).
 */
export async function validateUrlIsSafe(url: string): Promise<boolean> {
  const validator = new IsSafeUrlConstraint();
  return validator.validate(url);
}

/**
 * `validateUrlIsSafe` under a deadline, for a caller that wants the WHOLE check
 * bounded rather than only its lookup.
 *
 * The DNS phase is bounded inside the check itself (`resolveBothFamilies`), so
 * every caller -- the AI provider `baseUrl` validators, the startup check, the
 * push endpoint -- is covered without asking for it. This wrapper adds nothing
 * for them; it exists because the push sender bounds a per-send re-check whose
 * budget is part of a documented request worst case
 * (`PUSH_TEST_WORST_CASE_MS`), and that figure has to name a bound it owns.
 */
export async function validateUrlIsSafeWithin(
  url: string,
  timeoutMs: number = URL_SAFETY_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      validateUrlIsSafe(url),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Lighter validation for self-hosted providers (Ollama, OpenAI-compatible) that are
 * expected to run on private/local networks. Only checks protocol and rejects
 * embedded credentials.
 */
export function validateUrlBasicSafety(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.username || parsed.password) {
    return false;
  }
  return true;
}

export function IsSafeUrl(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol) {
    registerDecorator({
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      constraints: [],
      validator: IsSafeUrlConstraint,
    });
  };
}

/**
 * SSRF guard for AI provider baseUrl values. Dispatches on the sibling
 * `provider` field: cloud providers get the strict IsSafeUrl check (blocks
 * private IPs, metadata endpoints, DNS-rebinding) while self-hosted providers
 * (ollama, openai-compatible) get only the shape check here. Whether a
 * self-hosted URL may be private depends on its owner (an admin, or the
 * operator's AI_PRIVATE_BASE_URL_ALLOWLIST), which a DTO cannot know:
 * `AiService.validateBaseUrl` decides it (`ai-base-url-policy.ts`).
 */
@ValidatorConstraint({ async: true })
export class IsSafeProviderBaseUrlConstraint implements ValidatorConstraintInterface {
  private lastMessage = "baseUrl must be a valid HTTP/HTTPS URL";

  async validate(value: unknown, args: ValidationArguments): Promise<boolean> {
    if (typeof value !== "string" || value.length === 0) return false;

    const provider = (args.object as { provider?: AiProviderType }).provider;

    // No provider in the DTO means we can't pick the right policy at the
    // validation layer (e.g. UpdateAiConfigDto, where provider is immutable
    // and not echoed in the request). Fall back to basic safety here and let
    // the service layer run provider-aware validation against the stored row.
    if (!provider) {
      if (!validateUrlBasicSafety(value)) {
        this.lastMessage =
          "baseUrl must be a valid HTTP/HTTPS URL without embedded credentials";
        return false;
      }
      return true;
    }

    if (SELF_HOSTED_PROVIDERS.has(provider)) {
      if (!validateUrlBasicSafety(value)) {
        this.lastMessage =
          "baseUrl must be a valid HTTP/HTTPS URL without embedded credentials";
        return false;
      }
      return true;
    }

    const strict = new IsSafeUrlConstraint();
    const ok = await strict.validate(value);
    if (!ok) {
      this.lastMessage =
        "baseUrl must be a valid HTTP/HTTPS URL pointing to an external host";
    }
    return ok;
  }

  defaultMessage(): string {
    return this.lastMessage;
  }
}

export function IsSafeProviderBaseUrl(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol) {
    registerDecorator({
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      constraints: [],
      validator: IsSafeProviderBaseUrlConstraint,
    });
  };
}
