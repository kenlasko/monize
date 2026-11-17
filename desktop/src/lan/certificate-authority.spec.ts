import { generateKeyPairSync, X509Certificate } from "crypto";
import { AddressInfo } from "net";
import { connect, createServer, Server } from "tls";

import {
  certificateNames,
  derOf,
  fingerprintOf,
  issueRoot,
  issueServer,
  normalizeNames,
  PemPair,
  rootSubject,
  serverReissueReason,
} from "./certificate-authority";
import {
  basicConstraints,
  buildCertificate,
  KEY_USAGE,
  keyUsage,
  SubjectNames,
  toPem,
} from "./x509";

const NOW = new Date("2026-11-17T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const NAMES: SubjectNames = {
  dns: ["monize.local", "desktop-8f3k2qx.local"],
  ip: ["192.168.1.23", "fd12:3456::23"],
};

const root = issueRoot({ computerName: "DESKTOP-8F3K2QX", now: NOW });

/**
 * The same root without Name Constraints: the control that shows a refusal
 * below comes from the constraints and nothing else. (Node reports OpenSSL's
 * "permitted subtree violation" only as UNSPECIFIED.)
 */
function unconstrainedRoot(): PemPair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const subject = rootSubject("CONTROL");
  const der = buildCertificate({
    serial: Buffer.from([1]),
    issuer: subject,
    subject,
    notBefore: new Date(NOW.getTime() - DAY),
    notAfter: new Date(NOW.getTime() + 30 * DAY),
    publicKey,
    issuerPublicKey: publicKey,
    signingKey: privateKey,
    extensions: [
      basicConstraints(true, 0),
      keyUsage([KEY_USAGE.keyCertSign, KEY_USAGE.cRLSign]),
    ],
  });
  return {
    certPem: toPem(der),
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}
const server = issueServer({ root, names: NAMES, now: NOW });

/** A TLS handshake against `pair`, verified by OpenSSL against `ca`. */
async function handshake(
  pair: PemPair,
  ca: string,
  servername: string,
): Promise<{ authorized: boolean; error: string | null }> {
  const listener: Server = createServer(
    { cert: pair.certPem, key: pair.keyPem },
    (socket) => socket.end(),
  );
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const { port } = listener.address() as AddressInfo;
  try {
    return await new Promise((resolve) => {
      const socket = connect({
        host: "127.0.0.1",
        port,
        ca,
        servername,
        rejectUnauthorized: false,
      });
      socket.once("secureConnect", () => {
        const authorizationError = socket.authorizationError;
        const identity = socket.authorized
          ? null
          : String(authorizationError ?? "unauthorized");
        socket.destroy();
        resolve({ authorized: socket.authorized, error: identity });
      });
      socket.once("error", (error) =>
        resolve({ authorized: false, error: error.message }),
      );
    });
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
}

describe("issueRoot", () => {
  const cert = new X509Certificate(root.certPem);

  it("is a self-signed CA that can issue no intermediate", () => {
    expect(cert.ca).toBe(true);
    expect(cert.checkIssued(cert)).toBe(true);
    expect(cert.verify(cert.publicKey)).toBe(true);
  });

  it("names the computer, so a phone can tell two roots apart", () => {
    expect(cert.subject).toContain("CN=Monize on DESKTOP-8F3K2QX");
    expect(cert.subject).toContain("O=Monize");
  });

  it("is valid for ten years from an hour ago", () => {
    expect(new Date(cert.validFrom).getTime()).toBe(
      Math.floor((NOW.getTime() - 60 * 60 * 1000) / 1000) * 1000,
    );
    const years =
      (new Date(cert.validTo).getTime() - NOW.getTime()) / (365 * DAY);
    expect(years).toBeGreaterThan(9.9);
    expect(years).toBeLessThan(10.1);
  });

  it("keeps the subject free of characters a name printer escapes", () => {
    expect(rootSubject('KEN,"PC"=1').commonName).toBe("Monize on KENPC1");
    expect(rootSubject("").commonName).toBe("Monize");
  });

  it("exposes a fingerprint and DER bytes for the download", () => {
    expect(fingerprintOf(root.certPem)).toMatch(
      /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/,
    );
    expect(new X509Certificate(derOf(root.certPem)).fingerprint256).toBe(
      cert.fingerprint256,
    );
  });

  it("never puts the private key in the certificate", () => {
    expect(root.certPem).not.toContain("PRIVATE KEY");
    expect(root.keyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });
});

describe("issueServer", () => {
  const cert = new X509Certificate(server.certPem);

  it("is a leaf issued and signed by the root", () => {
    const rootCert = new X509Certificate(root.certPem);
    expect(cert.ca).toBe(false);
    expect(cert.checkIssued(rootCert)).toBe(true);
    expect(cert.verify(rootCert.publicKey)).toBe(true);
  });

  it("names every address it serves on", () => {
    expect(cert.checkHost("monize.local")).toBe("monize.local");
    expect(cert.checkHost("desktop-8f3k2qx.local")).toBe(
      "desktop-8f3k2qx.local",
    );
    expect(cert.checkIP("192.168.1.23")).toBe("192.168.1.23");
    expect(cert.checkHost("example.com")).toBeUndefined();
  });

  it("is valid for 397 days", () => {
    const days = (new Date(cert.validTo).getTime() - NOW.getTime()) / DAY;
    expect(Math.round(days)).toBe(397);
  });

  it("refuses to issue a certificate with no name", () => {
    expect(() =>
      issueServer({ root, names: { dns: [], ip: [] }, now: NOW }),
    ).toThrow(/at least one name/);
  });
});

describe("the chain under OpenSSL's own verification", () => {
  it("is trusted for monize.local by a device holding the root", async () => {
    const result = await handshake(server, root.certPem, "monize.local");
    expect(result).toEqual({ authorized: true, error: null });
  });

  it("is not trusted by a device without the root", async () => {
    const other = issueRoot({ computerName: "OTHER", now: NOW });
    const result = await handshake(server, other.certPem, "monize.local");
    expect(result.authorized).toBe(false);
  });

  it.each<[string, SubjectNames, string]>([
    [
      "a name outside .local",
      { dns: ["bank.example"], ip: [] },
      "bank.example",
    ],
    [
      "a public IP address",
      { dns: ["monize.local"], ip: ["8.8.8.8"] },
      "monize.local",
    ],
  ])(
    "cannot vouch for %s, even with the root's key",
    async (_label, names, servername) => {
      // The Name Constraints are what protect a phone if the key ever leaked.
      const forged = issueServer({ root, names, now: NOW });
      const refused = await handshake(forged, root.certPem, servername);
      expect(refused.authorized).toBe(false);

      const control = unconstrainedRoot();
      const accepted = await handshake(
        issueServer({ root: control, names, now: NOW }),
        control.certPem,
        servername,
      );
      expect(accepted).toEqual({ authorized: true, error: null });
    },
  );
});

describe("serverReissueReason", () => {
  const base = {
    rootCertPem: root.certPem,
    serverCertPem: server.certPem,
    names: NAMES,
  };

  it("keeps a current certificate that names the same addresses", () => {
    expect(serverReissueReason({ ...base, now: NOW })).toBeNull();
    // Order and spelling do not matter.
    expect(
      serverReissueReason({
        ...base,
        names: {
          dns: ["DESKTOP-8F3K2QX.local", "monize.local"],
          ip: ["fd12:3456:0:0:0:0:0:23", "192.168.1.23"],
        },
        now: NOW,
      }),
    ).toBeNull();
  });

  it("reissues when an address changed", () => {
    expect(
      serverReissueReason({
        ...base,
        names: { ...NAMES, ip: ["192.168.1.40", "fd12:3456::23"] },
        now: NOW,
      }),
    ).toBe("names-changed");
  });

  it("reissues inside the last 30 days", () => {
    expect(
      serverReissueReason({
        ...base,
        now: new Date(NOW.getTime() + 370 * DAY),
      }),
    ).toBe("expiring");
  });

  it("reissues a certificate from another root", () => {
    const other = issueRoot({ computerName: "OTHER", now: NOW });
    expect(
      serverReissueReason({ ...base, rootCertPem: other.certPem, now: NOW }),
    ).toBe("other-root");
  });
});

describe("certificateNames", () => {
  it("reads back exactly what was issued", () => {
    expect(certificateNames(new X509Certificate(server.certPem))).toEqual(
      normalizeNames(NAMES),
    );
  });
});
