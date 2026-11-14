import * as fs from "fs";
import * as path from "path";

/**
 * The desktop build ships what the container images ship, from the same build
 * output. The production stage of each Dockerfile is the source of truth for
 * the layout; desktop/staging-manifest.json mirrors it. This guard fails when a
 * Dockerfile gains a COPY the manifest does not account for.
 */

const repoRoot = path.resolve(__dirname, "..", "..");
const manifest: { entries: ManifestEntry[] } = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "staging-manifest.json"), "utf8"),
);

interface ManifestEntry {
  from: string;
  to: string;
  mirrors: string;
  kind?: string;
}

/** A COPY the desktop build deliberately does not stage, and why. */
const EXCLUDED: Record<string, Record<string, string>> = {
  backend: {
    "docker-entrypoint.sh":
      "the desktop supervisor runs the same three commands itself (db-init.js, db-migrate.js, main.js) with its own environment and readiness checks",
  },
  frontend: {},
};

/**
 * Kinds that ship something no container image has, so they quote no COPY:
 * the PostgreSQL binaries (the containers use a postgres image), the Visual
 * C++ runtime those binaries need on Windows, and the desktop's own files
 * (`kind: "desktop"`, such as the parent-watch preload).
 */
const NO_DOCKERFILE_LINE = ["postgres", "vc-runtime", "desktop"];

/**
 * Build output, installed packages and the build machine's Visual Studio
 * redistributable directory: not files in the repository.
 */
const BUILT = [
  "backend/dist",
  "frontend/.next/",
  "@embedded-postgres/",
  "vc-redist/",
];

function dockerfile(layer: string): string {
  return fs.readFileSync(path.join(repoRoot, layer, "Dockerfile"), "utf8");
}

/** The instructions of the last stage (the production stage), continuations joined. */
function productionInstructions(text: string): string[] {
  const joined = text.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  const instructions = joined
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  let start = 0;
  instructions.forEach((line, i) => {
    if (/^FROM\s/i.test(line)) {
      start = i;
    }
  });
  expect(instructions[start]).toMatch(/\bAS production\b/i);
  return instructions.slice(start);
}

/**
 * Where each COPY lands, relative to the stage's WORKDIR (/app). A destination
 * ending in `/` receives the source's basename when the source is a file or a
 * glob, and its contents when the source is a directory (a basename without a
 * dot or a glob).
 */
function copyDestinations(instructions: string[]): string[] {
  const out: string[] = [];
  for (const line of instructions) {
    if (!/^COPY\s/i.test(line)) {
      continue;
    }
    const args = line
      .split(/\s+/)
      .slice(1)
      .filter((arg) => !arg.startsWith("--"));
    const dest = args[args.length - 1];
    const src = args[args.length - 2];
    let rel = path.posix.normalize(dest.replace(/^\/app\/?/, "./"));
    if (dest.endsWith("/")) {
      const base = path.posix.basename(src);
      const isFile = base.includes("*") || /[^.]\.[a-z]+$/i.test(base);
      rel = path.posix.join(rel, isFile ? base : "");
    }
    out.push(rel.replace(/^\.(\/|$)/, "").replace(/\/$/, ""));
  }
  return out;
}

/** Does a manifest destination (relative to the layer) account for a COPY destination? */
function accounts(to: string, copyDest: string): boolean {
  if (copyDest === "") {
    return to === "";
  }
  if (copyDest.includes("*")) {
    const re = new RegExp(
      "^" +
        copyDest
          .split("*")
          .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*") +
        "$",
    );
    return re.test(to);
  }
  return to === copyDest || to.startsWith(copyDest + "/");
}

function layerDestinations(layer: string): string[] {
  const prefix = `${layer}/`;
  return manifest.entries
    .filter((e) => e.to === layer || e.to.startsWith(prefix))
    .map((e) => e.to.slice(prefix.length));
}

describe("staging manifest", () => {
  it.each(["backend", "frontend"])(
    "accounts for every COPY in the %s production stage",
    (layer) => {
      const copies = copyDestinations(
        productionInstructions(dockerfile(layer)),
      );
      expect(copies.length).toBeGreaterThan(3);
      const staged = layerDestinations(layer);
      const unaccounted = copies.filter(
        (dest) =>
          !(dest in EXCLUDED[layer]) &&
          !staged.some((to) => accounts(to, dest)),
      );
      expect({ layer, unaccounted }).toEqual({ layer, unaccounted: [] });
    },
  );

  it("gives every exclusion a reason and keeps none that no COPY needs", () => {
    for (const layer of ["backend", "frontend"]) {
      const copies = copyDestinations(
        productionInstructions(dockerfile(layer)),
      );
      for (const [dest, reason] of Object.entries(EXCLUDED[layer])) {
        expect(reason.length).toBeGreaterThan(20);
        expect(copies).toContain(dest);
      }
    }
  });

  it("copyDestinations resolves the forms the Dockerfiles use", () => {
    expect(
      copyDestinations([
        "COPY backend/package*.json ./",
        "COPY --from=builder --chown=a:b /app/.next/standalone ./",
        "COPY --from=builder /app/server-log-format.cjs ./",
        "COPY --from=help-images --chown=n:n /images ./help/images/",
        "COPY --from=builder /app/dist ./dist",
      ]),
    ).toEqual([
      "package*.json",
      "",
      "server-log-format.cjs",
      "help/images",
      "dist",
    ]);
  });

  it("quotes a COPY line that is really in the Dockerfile, unless it ships what no container has", () => {
    const squash = (s: string) => s.replace(/\s+/g, " ");
    for (const entry of manifest.entries) {
      expect(entry.mirrors.length).toBeGreaterThan(10);
      const match = /^(backend|frontend)\/Dockerfile: (COPY .+?)(?: \(|$)/.exec(
        entry.mirrors,
      );
      if (NO_DOCKERFILE_LINE.includes(entry.kind ?? "copy")) {
        expect({ to: entry.to, mirrors: entry.mirrors }).toEqual({
          to: entry.to,
          mirrors: expect.stringMatching(/^none: /),
        });
      } else {
        // Every other entry is a layer file and must name its real COPY.
        expect({ to: entry.to, quotes: match !== null }).toEqual({
          to: entry.to,
          quotes: true,
        });
        if (match !== null) {
          expect(squash(dockerfile(match[1]))).toContain(squash(match[2]));
        }
      }
    }
  });

  it("stages desktop-only files outside the layer directories", () => {
    const desktopOnly = manifest.entries.filter((e) => e.kind === "desktop");
    expect(desktopOnly.map((e) => e.to)).toEqual([
      "shell/parent-watch.cjs",
      "shell/icon.ico",
    ]);
    for (const entry of desktopOnly) {
      expect(entry.from).toMatch(/^desktop\//);
      expect(entry.to).not.toMatch(/^(backend|frontend)(\/|$)/);
    }
  });

  it("names sources that exist in the repository when they are tracked", () => {
    for (const entry of manifest.entries) {
      if (BUILT.some((prefix) => entry.from.startsWith(prefix))) {
        continue;
      }
      const source = entry.from.includes("*")
        ? path.dirname(entry.from)
        : entry.from;
      expect({
        from: entry.from,
        exists: fs.existsSync(path.join(repoRoot, source)),
      }).toEqual({ from: entry.from, exists: true });
    }
  });
});
