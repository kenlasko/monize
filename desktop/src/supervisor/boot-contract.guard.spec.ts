import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { dataPathsFor } from "../app-paths";
import { composeBackendEnv, composeFrontendEnv } from "../env";
import {
  BACKEND_BOOT_SCRIPTS,
  BACKEND_HEALTH_PATH,
  BACKEND_SERVER_SCRIPT,
} from "./backend";
import { FRONTEND_HEALTH_PATH, FRONTEND_SERVER_ARGS } from "./frontend";

/**
 * Do-not-drift guard for the boot path. The containers boot the backend
 * through `backend/docker-entrypoint.sh` and the frontend through the
 * production `CMD` of `frontend/Dockerfile`; the desktop app runs neither
 * file and repeats what they do in `backend.ts` and `frontend.ts`. This spec
 * reads the two files and fails when they and the supervisor disagree, so a
 * boot step, a start argument, an image-level variable or a health route
 * changed for the containers is never silently missing on the desktop.
 *
 * When it fails, the fix is in the supervisor (or `desktop/src/env.ts`), to
 * make the desktop do what the containers now do. It is never to teach this
 * spec to accept the difference.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..");
const read = (path: string): string =>
  readFileSync(join(REPO_ROOT, path), "utf8");

const ENTRYPOINT = "backend/docker-entrypoint.sh";
const SUPERVISOR = "desktop/src/supervisor/backend.ts";
/** The one step the entrypoint runs conditionally, and the desktop never does. */
const DEMO_CONDITION = '[ "$DEMO_MODE" = "true" ]';

interface Entrypoint {
  readonly errexit: boolean;
  /** `node <script>` lines outside any `if`, in order. */
  readonly steps: readonly {
    readonly script: string;
    readonly exec: boolean;
  }[];
  /** The condition of each top-level `if` block. */
  readonly conditions: readonly string[];
  /** Lines outside any `if` that are none of the above. */
  readonly unrecognised: readonly string[];
}

function parseEntrypoint(text: string): Entrypoint {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const steps: { script: string; exec: boolean }[] = [];
  const conditions: string[] = [];
  const unrecognised: string[] = [];
  let errexit = false;
  let depth = 0;
  for (const line of lines) {
    const opened = line.match(/^if\s+(.*?);\s*then$/);
    const step = line.match(/^(exec\s+)?node\s+(\S+)$/);
    if (opened) {
      if (depth === 0) conditions.push(opened[1]);
      depth += 1;
    } else if (depth > 0) {
      if (line === "fi") depth -= 1;
    } else if (line === "set -e") {
      errexit = true;
    } else if (step) {
      steps.push({ script: step[2], exec: step[1] !== undefined });
    } else {
      unrecognised.push(line);
    }
  }
  return { errexit, steps, conditions, unrecognised };
}

/** Every way the entrypoint and the supervisor's sequence disagree. */
function entrypointProblems(text: string): string[] {
  const parsed = parseEntrypoint(text);
  const scripts = parsed.steps.map((step) => step.script);
  const problems: string[] = [];
  if (!parsed.errexit) {
    problems.push(
      `${ENTRYPOINT} no longer has \`set -e\`: a failing step used to stop ` +
        `the container's boot, and still stops the desktop's (${SUPERVISOR}).`,
    );
  }
  for (const line of parsed.unrecognised) {
    problems.push(
      `${ENTRYPOINT} has a line this guard does not recognise: \`${line}\`. ` +
        `If it is a boot step, the desktop supervisor needs the same step in ` +
        `${SUPERVISOR}; then teach this guard the new shape.`,
    );
  }
  if (JSON.stringify(scripts) !== JSON.stringify(BACKEND_BOOT_SCRIPTS)) {
    problems.push(
      `${ENTRYPOINT} runs [${scripts.join(", ")}] unconditionally, but the ` +
        `desktop supervisor runs [${BACKEND_BOOT_SCRIPTS.join(", ")}]. The ` +
        `supervisor needs the same step in the same position: edit ` +
        `BACKEND_ONE_SHOT_STEPS / BACKEND_SERVER_SCRIPT in ${SUPERVISOR}.`,
    );
  }
  const execs = parsed.steps.filter((step) => step.exec);
  const last = parsed.steps[parsed.steps.length - 1];
  if (execs.length !== 1 || last !== execs[0]) {
    problems.push(
      `${ENTRYPOINT} must \`exec\` exactly its last step: that one is the ` +
        `server the supervisor keeps running (${BACKEND_SERVER_SCRIPT}); ` +
        `every step before it must run to completion first.`,
    );
  }
  if (JSON.stringify(parsed.conditions) !== JSON.stringify([DEMO_CONDITION])) {
    problems.push(
      `${ENTRYPOINT} has conditional steps under [${parsed.conditions.join(" | ")}]; ` +
        `the only one the desktop supervisor is known to skip safely is ` +
        `${DEMO_CONDITION}. Decide whether the desktop needs the new one ` +
        `and add it to ${SUPERVISOR} if it does.`,
    );
  }
  return problems;
}

/** The lines of the Dockerfile's `production` stage. */
function productionStage(dockerfile: string): string[] {
  const lines = read(dockerfile).split("\n");
  const start = lines.findIndex((line) =>
    /^FROM\s.*\sAS\s+production\s*$/.test(line),
  );
  if (start === -1) throw new Error(`${dockerfile} has no production stage`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^FROM\s/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Each `<INSTRUCTION> [...]` line of a stage, parsed; a shell-form line is not one. */
function execForms(stage: readonly string[], instruction: string): string[][] {
  return stage
    .filter((line) => line.startsWith(`${instruction} [`))
    .map((line) => JSON.parse(line.slice(instruction.length + 1)) as string[]);
}

/** The variable names a stage sets with `ENV`. */
function envNames(stage: readonly string[]): string[] {
  return stage
    .filter((line) => line.startsWith("ENV "))
    .map((line) => line.slice(4).trim().split(/[=\s]/)[0]);
}

const SAMPLE = {
  ports: { frontend: 3380, backend: 3381, postgres: 5433 },
  secrets: {
    jwtSecret: "j".repeat(40),
    encryptionKey: "e".repeat(40),
    databasePassword: "p".repeat(40),
  },
};
const BACKEND_ENV = composeBackendEnv(
  SAMPLE,
  dataPathsFor("/data/Monize", "linux"),
  { DEMO_MODE: "true" },
);
const FRONTEND_ENV = composeFrontendEnv(SAMPLE, {});

describe("the backend boot sequence matches docker-entrypoint.sh", () => {
  const entrypoint = read(ENTRYPOINT);

  it("runs exactly the entrypoint's unconditional steps, in order, and skips only the demo seed", () => {
    expect(entrypointProblems(entrypoint)).toEqual([]);
  });

  it("never runs with DEMO_MODE, the one conditional step's switch", () => {
    // Even with DEMO_MODE=true in the parent environment, as here.
    expect(BACKEND_ENV).not.toHaveProperty("DEMO_MODE");
  });

  it("is what the production image runs: dumb-init, then the entrypoint", () => {
    const stage = productionStage("backend/Dockerfile");
    expect(execForms(stage, "ENTRYPOINT")).toEqual([["dumb-init", "--"]]);
    expect(execForms(stage, "CMD")).toEqual([["./docker-entrypoint.sh"]]);
  });

  describe("the guard itself", () => {
    // A fixed copy of the entrypoint's shape, so these cases say what the
    // guard catches without turning red themselves when the real file drifts.
    const entrypoint = [
      "#!/bin/sh",
      "set -e",
      "",
      "# Every step logs for itself.",
      "node dist/db-init.js",
      "",
      "node dist/db-migrate.js",
      "",
      `if ${DEMO_CONDITION}; then`,
      "  node dist/db-demo-check.js || node dist/database/seed.js",
      "fi",
      "",
      "exec node dist/main.js",
      "",
    ].join("\n");

    it("accepts the shape the entrypoint has today", () => {
      expect(entrypointProblems(entrypoint)).toEqual([]);
    });

    it("fails on a step added to the entrypoint, naming where the supervisor needs it", () => {
      const added = entrypoint.replace(
        "node dist/db-migrate.js\n",
        "node dist/db-migrate.js\n\nnode dist/db-backfill.js\n",
      );
      expect(added).not.toBe(entrypoint);

      const [problem] = entrypointProblems(added);

      expect(problem).toContain("dist/db-backfill.js");
      expect(problem).toContain("supervisor needs the same step");
      expect(problem).toContain(SUPERVISOR);
    });

    it("fails on a step removed or reordered", () => {
      const removed = entrypoint.replace("node dist/db-init.js\n", "");
      const reordered = entrypoint
        .replace("node dist/db-init.js\n", "node dist/TEMP.js\n")
        .replace("node dist/db-migrate.js\n", "node dist/db-init.js\n")
        .replace("node dist/TEMP.js\n", "node dist/db-migrate.js\n");

      expect(entrypointProblems(removed)).toHaveLength(1);
      expect(entrypointProblems(reordered)).toHaveLength(1);
    });

    it("fails on a line that is not a node step, such as a wait script or an export", () => {
      const withScript = entrypoint.replace(
        "node dist/db-init.js\n",
        "./wait-for-db.sh\nnode dist/db-init.js\n",
      );

      expect(entrypointProblems(withScript)).toEqual([
        expect.stringContaining("`./wait-for-db.sh`"),
      ]);
    });

    it("fails on a second conditional block, or a changed condition", () => {
      const second = entrypoint.replace(
        "exec node",
        'if [ "$RUN_BACKFILL" = "true" ]; then\n  node dist/backfill.js\nfi\n\nexec node',
      );
      const changed = entrypoint.replace(DEMO_CONDITION, '[ -n "$SEED" ]');

      expect(entrypointProblems(second)).toEqual([
        expect.stringContaining("RUN_BACKFILL"),
      ]);
      expect(entrypointProblems(changed)).toHaveLength(1);
    });

    it("fails when the server is no longer the exec'd last step, or `set -e` is dropped", () => {
      const noExec = entrypoint.replace("exec node", "node");
      const noErrexit = entrypoint.replace("set -e\n", "");

      expect(entrypointProblems(noExec)).toEqual([
        expect.stringContaining("`exec` exactly its last step"),
      ]);
      expect(entrypointProblems(noErrexit)).toEqual([
        expect.stringContaining("set -e"),
      ]);
    });

    it("does not read a step out of a comment", () => {
      const commented = entrypoint.replace(
        "node dist/db-init.js\n",
        "# node dist/old-step.js\nnode dist/db-init.js\n",
      );

      expect(entrypointProblems(commented)).toEqual([]);
    });
  });
});

describe("the frontend start command matches the production Dockerfile", () => {
  const stage = productionStage("frontend/Dockerfile");

  it("starts the server with the arguments of the image's CMD", () => {
    // If this fails, the image's start command changed: make
    // FRONTEND_SERVER_ARGS in desktop/src/supervisor/frontend.ts the same.
    expect(execForms(stage, "CMD")).toEqual([
      ["node", ...FRONTEND_SERVER_ARGS],
    ]);
  });

  it("has no entrypoint script whose steps the desktop would be missing", () => {
    expect(execForms(stage, "ENTRYPOINT")).toEqual([["dumb-init", "--"]]);
  });
});

describe("variables the production images set are set for the desktop children", () => {
  // An `ENV` in a production stage is configuration the layer runs with in a
  // container and would silently lack on the desktop. If this fails, add the
  // variable to the composed environment in desktop/src/env.ts.
  it("the backend image's", () => {
    const names = envNames(productionStage("backend/Dockerfile"));
    expect(names).toContain("NODE_ENV");
    expect(names.filter((name) => !(name in BACKEND_ENV))).toEqual([]);
  });

  it("the frontend image's", () => {
    const names = envNames(productionStage("frontend/Dockerfile"));
    expect(names).toEqual(expect.arrayContaining(["PORT", "HOSTNAME"]));
    expect(names.filter((name) => !(name in FRONTEND_ENV))).toEqual([]);
  });
});

describe("the health routes the supervisor polls exist", () => {
  it("the backend's readiness route is the global prefix, the health controller, then `ready`", () => {
    const prefix = read("backend/src/main.ts").match(
      /setGlobalPrefix\(\s*"([^"]+)"/,
    );
    const controller = read("backend/src/health/health.controller.ts");
    const base = controller.match(/@Controller\("([^"]+)"\)/);

    expect(controller).toContain('@Get("ready")');
    expect(`/${prefix?.[1]}/${base?.[1]}/ready`).toBe(BACKEND_HEALTH_PATH);
  });

  it("the frontend's liveness route is served by the frontend itself, not forwarded", () => {
    const route = `frontend/src/app${FRONTEND_HEALTH_PATH}/route.ts`;

    expect(existsSync(join(REPO_ROOT, route))).toBe(true);
    expect(read(route)).toMatch(/export async function GET\b/);
    // The proxy forwards /api/* to the backend except this prefix.
    const exempt = read("frontend/src/proxy.ts").match(
      /pathname\.startsWith\("(\/api\/v1\/health\/)"\)/,
    );
    expect(FRONTEND_HEALTH_PATH.startsWith(exempt?.[1] ?? "no exemption")).toBe(
      true,
    );
  });
});
