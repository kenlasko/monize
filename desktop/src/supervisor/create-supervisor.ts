import { posix, win32 } from "path";

import { AppConfig, PlainSecrets, SECRET_NAMES } from "../app-config";
import { AppPaths } from "../app-paths";
import {
  backendOrigin,
  composeBackendEnv,
  composeFrontendEnv,
  frontendOrigin,
} from "../env";
import { FetchLike } from "../health";
import { Logger } from "../logger";
import { BACKEND_HEALTH_PATH } from "./backend";
import { createBootSupervisor, LayerTarget } from "./boot";
import { ChildOptions, createChildLauncher, SpawnFn } from "./child";
import { Clock } from "./clock";
import { FRONTEND_HEALTH_PATH } from "./frontend";
import { BootOptions, PostgresRunner, Supervisor } from "./types";

/**
 * The one call the Electron main process makes to get a supervisor: it turns
 * the bootstrap's result (`loadOrCreateConfig`) and the resolved paths into
 * the two child environments, the two working directories and the two health
 * URLs, and wires them to the state machine.
 */

export interface SupervisorInput {
  /** `resolveAppPaths(...)`. */
  readonly paths: AppPaths;
  /** `loadOrCreateConfig(...).config`; only the ports are read. */
  readonly config: Pick<AppConfig, "ports">;
  /** `loadOrCreateConfig(...).secrets`. */
  readonly secrets: PlainSecrets;
  readonly logger: Logger;
  readonly postgres: PostgresRunner;
  /** `process.env`; only the allowlisted names in `env.ts` reach a child. */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** `process.execPath`: Electron's binary, run as Node. */
  readonly execPath: string;
  /** Decides the path flavour of the layer directories. Default: the host's. */
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnFn;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  readonly options?: Partial<BootOptions>;
  readonly childOptions?: Partial<ChildOptions>;
}

export interface LayerTargets {
  readonly backend: LayerTarget;
  readonly frontend: LayerTarget;
}

/**
 * Where each layer runs and how to tell it is up. Throws `ChildEnvError` when
 * a secret is empty or too short: that is a damaged install, found before
 * anything has been started.
 */
export function layerTargets(
  input: Pick<
    SupervisorInput,
    "paths" | "config" | "secrets" | "baseEnv" | "platform"
  >,
): LayerTargets {
  const { ports } = input.config;
  const path = (input.platform ?? process.platform) === "win32" ? win32 : posix;
  return {
    backend: {
      cwd: path.join(input.paths.resourcesDir, "backend"),
      env: composeBackendEnv(
        { ports, secrets: input.secrets },
        input.paths.data,
        input.baseEnv,
      ),
      healthUrl: `${backendOrigin(ports)}${BACKEND_HEALTH_PATH}`,
    },
    frontend: {
      cwd: path.join(input.paths.resourcesDir, "frontend"),
      env: composeFrontendEnv({ ports }, input.baseEnv),
      healthUrl: `${frontendOrigin(ports)}${FRONTEND_HEALTH_PATH}`,
    },
  };
}

export function createSupervisor(input: SupervisorInput): Supervisor {
  const { logger } = input;
  // Before any child can print one: a secret in a child's output is replaced
  // in the log file, the failure's log tail and stdout alike.
  for (const name of SECRET_NAMES) logger.redact(input.secrets[name]);
  const targets = layerTargets(input);
  return createBootSupervisor({
    postgres: input.postgres,
    launch: createChildLauncher({
      execPath: input.execPath,
      logger,
      spawn: input.spawn,
      clock: input.clock,
      options: input.childOptions,
    }),
    logger,
    backend: targets.backend,
    frontend: targets.frontend,
    fetch: input.fetch,
    clock: input.clock,
    options: input.options,
  });
}
