import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import * as dns from "dns";
import * as net from "net";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "169.254.169.254",
  "metadata",
]);

const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost"];

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^fc00:/i,
  /^fd/i,
  /^fe80:/i,
  /^::1$/,
  /^::$/,
  /^::ffff:(?:127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.)/i,
];

/**
 * Normalize an IP address string to dotted-decimal (IPv4),
 * catching hex/octal/decimal encoded IPs that bypass regex-based checks.
 */
function normalizeIp(hostname: string): string | null {
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

function isPrivateIp(ip: string): boolean {
  for (const pattern of PRIVATE_IP_RANGES) {
    if (pattern.test(ip)) return true;
  }
  return false;
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

    const hostname = parsed.hostname.toLowerCase();

    if (BLOCKED_HOSTNAMES.has(hostname)) {
      return false;
    }

    for (const suffix of BLOCKED_SUFFIXES) {
      if (hostname.endsWith(suffix) || hostname === suffix.slice(1)) {
        return false;
      }
    }

    // Check for alternative IP encodings (hex, decimal, octal, IPv6-mapped)
    const normalizedIp = normalizeIp(hostname);
    if (normalizedIp && isPrivateIp(normalizedIp)) {
      return false;
    }

    for (const pattern of PRIVATE_IP_RANGES) {
      if (pattern.test(hostname)) {
        return false;
      }
    }

    if (parsed.username || parsed.password) {
      return false;
    }

    // DNS resolution check: resolve hostname and verify IPs are not private
    if (!net.isIP(hostname) && !normalizedIp) {
      try {
        const [ipv4Addrs, ipv6Addrs] = await Promise.all([
          dnsResolve(hostname),
          dnsResolve6(hostname),
        ]);
        const allAddrs = [...ipv4Addrs, ...ipv6Addrs];
        if (allAddrs.length > 0 && allAddrs.every((ip) => isPrivateIp(ip))) {
          return false;
        }
      } catch {
        // DNS resolution failed — allow the URL (the actual HTTP request will fail)
      }
    }

    return true;
  }

  defaultMessage(): string {
    return "baseUrl must be a valid HTTP/HTTPS URL pointing to an external host";
  }
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
