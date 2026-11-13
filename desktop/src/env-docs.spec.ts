import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import { dataPathsFor } from "./app-paths";
import { composeBackendEnv, composeFrontendEnv } from "./env";

/**
 * Do-not-drift guard: every variable the desktop children are given must be
 * one the backend or frontend documents, so a rename there turns this red
 * instead of leaving the desktop build setting a name nobody reads.
 *
 * "Documented" is exactly what `scripts/check-env-docs.mjs` accepts: a
 * `NAME=` line in `.env.example` (commented or not) or a key in a
 * `docker-compose*.yml` service environment. That script already forces every
 * variable the code reads into one of those places, so the chain is: code ->
 * documentation (that script) -> desktop (this spec). The compose files count
 * because the database variables (`DATABASE_HOST` and friends) are documented
 * only there, mapped from `POSTGRES_*`.
 */

const REPO_ROOT = join(__dirname, "..", "..");

/**
 * Process-level names that are not application settings, so the env
 * documentation does not list them. Shrink-only.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    "ELECTRON_RUN_AS_NODE",
    "makes Electron's binary behave as plain Node (plan D2)",
  ],
  ["TZ", "the C runtime's zone; the containers set it in their images"],
  [
    "HOSTNAME",
    "the Next.js standalone server's bind address, read by its server.js",
  ],
]);

function documentedInEnvExample(): Set<string> {
  const text = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
  const names = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const match = rawLine
      .replace(/^#\s*/, "")
      .trim()
      .match(/^([A-Z][A-Z0-9_]+)=/);
    if (match) names.add(match[1]);
  }
  return names;
}

function documentedInCompose(): Set<string> {
  const names = new Set<string>();
  const files = readdirSync(REPO_ROOT).filter((name) =>
    /^docker-compose[\w.-]*\.ya?ml$/.test(name),
  );
  for (const file of files) {
    const text = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const match of text.matchAll(/^[\s-]*([A-Z][A-Z0-9_]+):\s*[^\n]+/gm)) {
      names.add(match[1]);
    }
  }
  return names;
}

const config = {
  ports: { frontend: 3380, backend: 3381, postgres: 5433 },
  secrets: {
    jwtSecret: "j".repeat(40) + "abcdefgh",
    encryptionKey: "e".repeat(40) + "abcdefgh",
    databasePassword: "p".repeat(40),
  },
};
// An empty parent env, so only the keys the desktop sets are checked.
const emitted = [
  ...Object.keys(composeBackendEnv(config, dataPathsFor("/data", "linux"), {})),
  ...Object.keys(composeFrontendEnv(config, {})),
];

describe("desktop child environment vs. the documented variables", () => {
  const documented = new Set([
    ...documentedInEnvExample(),
    ...documentedInCompose(),
  ]);

  it("reads a real .env.example", () => {
    expect(documentedInEnvExample().has("JWT_SECRET")).toBe(true);
  });

  it("sets only documented variables, plus the named exemptions", () => {
    const undocumented = [...new Set(emitted)]
      .filter((name) => !documented.has(name) && !EXEMPT.has(name))
      .sort();
    expect(undocumented).toEqual([]);
  });

  it("keeps no exemption that the documentation already covers or that is unused", () => {
    const stale = [...EXEMPT.keys()].filter(
      (name) => documented.has(name) || !emitted.includes(name),
    );
    expect(stale).toEqual([]);
  });
});
