import { LayerRuntime } from "./backend";
import { ChildHandle, ChildLauncher } from "./child";

/**
 * The frontend's start command: the arguments after `node` in the production
 * `CMD` of `frontend/Dockerfile`, run in `<resources>/frontend` as they are
 * run in `/app` in the image. `boot-contract.guard.spec.ts` fails when the
 * two differ.
 */
export const FRONTEND_SERVER_ARGS: readonly string[] = [
  "--require",
  "./server-log-format.cjs",
  "server.js",
];

/**
 * The frontend's liveness route, `frontend/src/app/api/v1/health/live/route.ts`,
 * answered by the Next.js server itself: `frontend/src/proxy.ts` leaves
 * `/api/v1/health/` alone instead of forwarding it to the backend.
 */
export const FRONTEND_HEALTH_PATH = "/api/v1/health/live";

/** Start the standalone server; the caller keeps the handle and waits for liveness. */
export function startFrontendServer(
  launch: ChildLauncher,
  runtime: LayerRuntime,
): ChildHandle {
  return launch({
    source: "frontend",
    args: FRONTEND_SERVER_ARGS,
    cwd: runtime.cwd,
    env: runtime.env,
  });
}
