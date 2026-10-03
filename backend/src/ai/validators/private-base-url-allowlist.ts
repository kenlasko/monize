import { isIP } from "node:net";
import { unbracketHost } from "./safe-url.validator";

/**
 * One operator-approved private AI endpoint: a host, and optionally the one
 * port on it. `port === null` means every port on that host.
 */
export interface PrivateBaseUrlEntry {
  host: string;
  port: number | null;
}

export interface PrivateBaseUrlAllowlist {
  entries: PrivateBaseUrlEntry[];
  /** Entries that could not be read. They allow nothing. */
  invalid: string[];
}

const MAX_RAW_LENGTH = 4096;
const MAX_ENTRIES = 32;

/**
 * The host as the URL parser writes it, unbracketed and lowercased, so an entry
 * and a request URL compare on one spelling: `0x7f.1` and `127.0.0.1` are the
 * same host to the parser, and so they are the same host here.
 */
function canonicalHost(host: string): string | null {
  const bracketed = isIP(host) === 6 ? `[${host}]` : host;
  try {
    const url = new URL(`http://${bracketed}/`);
    if (url.username || url.password || url.port) return null;
    return unbracketHost(url.hostname.toLowerCase());
  } catch {
    return null;
  }
}

function parseEntry(raw: string): PrivateBaseUrlEntry | null {
  const text = raw.trim().toLowerCase();
  // `[v6]`, `[v6]:port`, `name`, `name:port`, `v4`, `v4:port`. Nothing else: no
  // scheme, no path, no userinfo, no wildcard, no CIDR -- an entry names exactly
  // one host an operator has decided the server may reach on a user's behalf.
  const match =
    /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(text) ??
    /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match) return null;
  const host = canonicalHost(match[1]);
  if (!host) return null;
  if (match[2] === undefined) return { host, port: null };
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/**
 * `AI_PRIVATE_BASE_URL_ALLOWLIST`: comma-separated `host` or `host:port`
 * entries naming the private AI endpoints (a LAN Ollama, a vLLM box) that a
 * non-admin user's self-hosted provider may point at. Operator-only, empty by
 * default; an entry that cannot be read is reported and allows nothing.
 *
 * It is a separate variable from `UNIFIEDPUSH_PRIVATE_ENDPOINTS` because the
 * shape differs: a push distributor is an HTTPS DNS origin pinned to one
 * RFC1918 address, while a self-hosted model server is usually plain HTTP on a
 * LAN address, a container name or loopback.
 */
export function privateBaseUrlAllowlist(
  raw = process.env.AI_PRIVATE_BASE_URL_ALLOWLIST,
): PrivateBaseUrlAllowlist {
  return parsePrivateHostAllowlist(raw);
}

/**
 * The parser behind `privateBaseUrlAllowlist`, taking the raw text and no
 * environment default, so another operator allowlist with the same grammar
 * (`EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST`) reuses it without being able to
 * fall back, by an omitted argument, to the AI variable.
 */
export function parsePrivateHostAllowlist(
  raw: string | undefined,
): PrivateBaseUrlAllowlist {
  if (!raw?.trim()) return { entries: [], invalid: [] };
  if (raw.length > MAX_RAW_LENGTH) return { entries: [], invalid: [raw] };
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const entries: PrivateBaseUrlEntry[] = [];
  const invalid: string[] = [];
  for (const [index, part] of parts.entries()) {
    const entry = index < MAX_ENTRIES ? parseEntry(part) : null;
    if (entry) entries.push(entry);
    else invalid.push(part);
  }
  return { entries, invalid };
}

/**
 * Whether a provider URL's host and port are on the operator's allowlist. A URL
 * without an explicit port is compared on its scheme's default port, so
 * `ollama.lan:80` matches `http://ollama.lan/`.
 */
export function isAllowlistedPrivateBaseUrl(
  url: string | URL,
  allowlist: PrivateBaseUrlAllowlist = privateBaseUrlAllowlist(),
): boolean {
  if (allowlist.entries.length === 0) return false;
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = unbracketHost(parsed.hostname.toLowerCase());
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  return allowlist.entries.some(
    (entry) =>
      entry.host === host && (entry.port === null || entry.port === port),
  );
}

/**
 * Whether a bare host and port are on an allowlist (no URL, no scheme). The host
 * is compared on the spelling the URL parser gives it, exactly as a URL is, so
 * `0x7f.1` and `127.0.0.1` are one host here too.
 */
export function isAllowlistedPrivateHostPort(
  host: string,
  port: number,
  allowlist: PrivateBaseUrlAllowlist,
): boolean {
  if (allowlist.entries.length === 0) return false;
  const canonical = canonicalHost(unbracketHost(host.trim().toLowerCase()));
  if (!canonical) return false;
  return allowlist.entries.some(
    (entry) =>
      entry.host === canonical && (entry.port === null || entry.port === port),
  );
}
