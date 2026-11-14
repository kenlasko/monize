import { PlainSecrets } from "./app-config";
import { DataPaths } from "./app-paths";
import { Ports } from "./ports";

/**
 * The environments handed to the backend and frontend children (plan
 * section 6). Pure, and the guard plan section 8 asks for: the listeners are
 * loopback-only, the origin is the frontend's, and no secret is empty.
 *
 * The parent environment is NOT inherited. Only the variables a child process
 * needs to run at all pass through (`INHERITED_ENV`), so a stray user-level
 * `DATABASE_HOST`, `NODE_OPTIONS`, `PORT` or `HOST` cannot change what the app
 * does. Every application variable is then set by this module, last, so it
 * wins over anything inherited.
 */

export type ChildEnv = Readonly<Record<string, string>>;

export interface ChildEnvConfig {
  readonly ports: Ports;
  readonly secrets: PlainSecrets;
}

export const LOOPBACK = "127.0.0.1";
export const DATABASE_USER = "monize";
export const DATABASE_NAME = "monize";
/**
 * The runtime role the backend connects as. db-init creates it (and rotates
 * its password) on every start, because the cluster's owner is a superuser
 * here and can; the backend's startup check then refuses to serve unless the
 * connection is that role and it holds no SUPERUSER or BYPASSRLS.
 */
export const DATABASE_APP_USER = "monize_app";
export const RLS_MODE = "enforce";

/** The backend's floor for `JWT_SECRET` and `ENCRYPTION_KEY`. */
const MIN_KEY_LENGTH = 32;

/**
 * Parent variables a child may inherit. Matched case-insensitively, because
 * Windows environment names are (`Path` and `PATH` are one variable), and
 * passed through under the parent's own spelling.
 */
export const INHERITED_ENV: readonly string[] = [
  // Windows: Winsock, the crypto provider and other system DLLs fail to load
  // without SystemRoot; windir and SystemDrive are read alongside it.
  "SystemRoot",
  "windir",
  "SystemDrive",
  // The shell child_process uses on Windows when asked for one.
  "ComSpec",
  // Locating executables (PostgreSQL tools, the shell); PATHEXT is how
  // Windows resolves a bare command name to `.exe`/`.cmd`.
  "PATH",
  "PATHEXT",
  // os.tmpdir(): TEMP/TMP on Windows, TMPDIR on POSIX.
  "TEMP",
  "TMP",
  "TMPDIR",
  // os.homedir(): USERPROFILE (or HOMEDRIVE+HOMEPATH) on Windows, HOME on POSIX.
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  // Per-user application folders some libraries resolve their caches under.
  "LOCALAPPDATA",
  "APPDATA",
  // The character set for anything that reads a locale from the environment;
  // ICU formatting is unaffected (TZ and the app's own locale settings rule).
  "LANG",
];

const INHERITED_LOWER = new Set(
  INHERITED_ENV.map((name) => name.toLowerCase()),
);

/** The allowlisted subset of `baseEnv`, as a new object. */
export function inheritedEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value !== undefined && INHERITED_LOWER.has(name.toLowerCase())) {
      picked[name] = value;
    }
  }
  return picked;
}

export class ChildEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChildEnvError";
  }
}

function requireSecret(value: string, variable: string, min: number): string {
  if (value.trim().length === 0) {
    throw new ChildEnvError(
      `${variable} is empty; refusing to start a child without it.`,
    );
  }
  if (value.length < min) {
    throw new ChildEnvError(`${variable} is shorter than ${min} characters.`);
  }
  return value;
}

export function frontendOrigin(ports: Ports): string {
  return `http://${LOOPBACK}:${ports.frontend}`;
}

export function backendOrigin(ports: Ports): string {
  return `http://${LOOPBACK}:${ports.backend}`;
}

/**
 * Shared by both children: what makes them a production Node process.
 * Both children also get both bind variables, `HOST` (the backend's, plan
 * B2) and `HOSTNAME` (the Next.js standalone server's): plan section 6 lists
 * one per child, and setting the other too costs nothing and means a future
 * reader of either name still binds loopback.
 */
function runtimeEnv(): Record<string, string> {
  return {
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    TZ: "UTC",
  };
}

export function composeBackendEnv(
  config: ChildEnvConfig,
  paths: DataPaths,
  baseEnv: Readonly<Record<string, string | undefined>>,
): ChildEnv {
  const { ports, secrets } = config;
  const origin = frontendOrigin(ports);
  return {
    ...inheritedEnv(baseEnv),
    ...runtimeEnv(),
    PORT: String(ports.backend),
    HOST: LOOPBACK,
    HOSTNAME: LOOPBACK,
    DATABASE_HOST: LOOPBACK,
    DATABASE_PORT: String(ports.postgres),
    DATABASE_USER,
    DATABASE_PASSWORD: requireSecret(
      secrets.databasePassword,
      "DATABASE_PASSWORD",
      1,
    ),
    DATABASE_NAME,
    RLS_MODE,
    DATABASE_APP_USER,
    DATABASE_APP_PASSWORD: requireSecret(
      secrets.databaseAppPassword,
      "DATABASE_APP_PASSWORD",
      1,
    ),
    JWT_SECRET: requireSecret(secrets.jwtSecret, "JWT_SECRET", MIN_KEY_LENGTH),
    ENCRYPTION_KEY: requireSecret(
      secrets.encryptionKey,
      "ENCRYPTION_KEY",
      MIN_KEY_LENGTH,
    ),
    PUBLIC_APP_URL: origin,
    CORS_ORIGIN: origin,
    DISABLE_HTTPS_HEADERS: "true",
    BACKUP_CONTAINER_DIR: paths.backups,
    ATTACHMENT_CONTAINER_DIR: paths.attachments,
    BACKUP_ALLOWED_ROOTS: paths.backups,
    UPDATE_CHECK_ENABLED: "false",
  };
}

export function composeFrontendEnv(
  config: Pick<ChildEnvConfig, "ports">,
  baseEnv: Readonly<Record<string, string | undefined>>,
): ChildEnv {
  const { ports } = config;
  return {
    ...inheritedEnv(baseEnv),
    ...runtimeEnv(),
    PORT: String(ports.frontend),
    HOST: LOOPBACK,
    HOSTNAME: LOOPBACK,
    INTERNAL_API_URL: backendOrigin(ports),
    DISABLE_HTTPS_HEADERS: "true",
  };
}
