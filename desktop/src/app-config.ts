import { promises as fs } from "fs";

import { writeFileAtomic } from "./atomic-write";
import { isMdnsLabel } from "./lan/names";
import { isValidPort, PORT_NAMES, Ports } from "./ports";
import { StoredSecret } from "./secrets";

/**
 * `config.json`, the file under the data directory that holds the ports, the
 * local-network settings and the wrapped secrets.
 *
 * Read strictly: an unknown version, a missing key, an extra key or a value of
 * the wrong type is a `ConfigError`, never a default. A default here would be
 * a regenerated secret or a new origin, which is the damage plan D7 and D8
 * exist to prevent. The data directory itself is not recorded: a pointer kept
 * inside the directory it points to cannot help anyone find that directory.
 */

/**
 * Version 1 has no `lan` block; version 2 adds it. The version written follows
 * from the content: a config whose `lan` is null (local-network access never
 * turned on) is still written as version 1, so a person who never uses the
 * feature can go back to an older build, which reads version 1 only.
 */
export const CONFIG_VERSIONS = [1, 2] as const;
export type ConfigVersion = (typeof CONFIG_VERSIONS)[number];

export const SECRET_NAMES = [
  "jwtSecret",
  "encryptionKey",
  "databasePassword",
  // The unprivileged runtime role's password: the backend connects as that
  // role with row-level security enforced (RLS_MODE=enforce), never as the
  // cluster's superuser, which bypasses every policy.
  "databaseAppPassword",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export type StoredSecrets = Readonly<Record<SecretName, StoredSecret>>;
export type PlainSecrets = Readonly<Record<SecretName, string>>;

/**
 * Local-network access (docs/future-plans/desktop-lan-access.md, L1 and L7).
 * `port` is the LAN listener's, distinct from the three loopback ports;
 * `hostname` is the mDNS label last claimed (`monize`, `monize-2`, ...), or
 * null before the first claim.
 */
export interface LanSettings {
  readonly enabled: boolean;
  readonly port: number;
  readonly hostname: string | null;
}

export interface AppConfig {
  readonly ports: Ports;
  /** Null until local-network access is first turned on. */
  readonly lan: LanSettings | null;
  readonly secrets: StoredSecrets;
}

export type ConfigErrorCode =
  | "unreadable"
  | "not-json"
  | "unsupported-version"
  | "invalid"
  | "damaged-install";

export class ConfigError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(where: string, what: string): never {
  throw new ConfigError("invalid", `config.json: ${where} ${what}.`);
}

function exactKeys(
  value: unknown,
  where: string,
  keys: readonly string[],
): Json {
  if (!isObject(value)) invalid(where, "is not an object");
  for (const key of keys) {
    if (!(key in value)) invalid(`${where}.${key}`, "is missing");
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalid(`${where}.${key}`, "is not a known key");
  }
  return value;
}

function parsePorts(value: unknown): Ports {
  const raw = exactKeys(value, "ports", PORT_NAMES);
  for (const name of PORT_NAMES) {
    if (!isValidPort(raw[name])) {
      invalid(`ports.${name}`, "is not an integer port from 1024 to 65535");
    }
  }
  const ports: Ports = {
    frontend: raw.frontend as number,
    backend: raw.backend as number,
    postgres: raw.postgres as number,
  };
  if (new Set(Object.values(ports)).size !== PORT_NAMES.length) {
    invalid("ports", "holds the same port twice");
  }
  return ports;
}

function parseSecret(value: unknown, name: SecretName): StoredSecret {
  const where = `secrets.${name}`;
  const raw = exactKeys(value, where, ["enc", "value"]);
  if (raw.enc !== "safeStorage" && raw.enc !== "plain") {
    invalid(`${where}.enc`, 'is neither "safeStorage" nor "plain"');
  }
  if (typeof raw.value !== "string" || raw.value.length === 0) {
    invalid(`${where}.value`, "is not a non-empty string");
  }
  return { enc: raw.enc, value: raw.value };
}

function parseSecrets(value: unknown): StoredSecrets {
  const raw = exactKeys(value, "secrets", SECRET_NAMES);
  return {
    jwtSecret: parseSecret(raw.jwtSecret, "jwtSecret"),
    encryptionKey: parseSecret(raw.encryptionKey, "encryptionKey"),
    databasePassword: parseSecret(raw.databasePassword, "databasePassword"),
    databaseAppPassword: parseSecret(
      raw.databaseAppPassword,
      "databaseAppPassword",
    ),
  };
}

function parseLan(value: unknown, ports: Ports): LanSettings {
  const raw = exactKeys(value, "lan", ["enabled", "port", "hostname"]);
  if (typeof raw.enabled !== "boolean") {
    invalid("lan.enabled", "is not true or false");
  }
  if (!isValidPort(raw.port)) {
    invalid("lan.port", "is not an integer port from 1024 to 65535");
  }
  if (PORT_NAMES.some((name) => ports[name] === raw.port)) {
    invalid("lan.port", "is one of the loopback ports");
  }
  if (raw.hostname !== null && !isMdnsLabel(raw.hostname)) {
    invalid("lan.hostname", "is neither null nor a DNS label");
  }
  return {
    enabled: raw.enabled,
    port: raw.port as number,
    hostname: raw.hostname as string | null,
  };
}

function isConfigVersion(value: unknown): value is ConfigVersion {
  return CONFIG_VERSIONS.some((version) => version === value);
}

/** Parse and validate the file's text. Never fills in a default. */
export function parseConfig(text: string): AppConfig {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ConfigError("not-json", "config.json is not valid JSON.");
  }
  if (!isObject(data)) invalid("the top level", "is not an object");
  const version = data.version;
  if (!isConfigVersion(version)) {
    throw new ConfigError(
      "unsupported-version",
      `config.json has version ${JSON.stringify(version)}; this build ` +
        `reads versions ${CONFIG_VERSIONS.join(" and ")} only.`,
    );
  }
  const keys =
    version === 1
      ? ["version", "ports", "secrets"]
      : ["version", "ports", "lan", "secrets"];
  const raw = exactKeys(data, "the top level", keys);
  const ports = parsePorts(raw.ports);
  return {
    ports,
    lan: version === 1 ? null : parseLan(raw.lan, ports),
    secrets: parseSecrets(raw.secrets),
  };
}

/** The version `serializeConfig` writes for this content. */
export function configVersionOf(config: AppConfig): ConfigVersion {
  return config.lan === null ? 1 : 2;
}

export function serializeConfig(config: AppConfig): string {
  const { lan } = config;
  const ordered = {
    version: configVersionOf(config),
    ports: {
      frontend: config.ports.frontend,
      backend: config.ports.backend,
      postgres: config.ports.postgres,
    },
    ...(lan === null
      ? {}
      : {
          lan: { enabled: lan.enabled, port: lan.port, hostname: lan.hostname },
        }),
    secrets: {
      jwtSecret: config.secrets.jwtSecret,
      encryptionKey: config.secrets.encryptionKey,
      databasePassword: config.secrets.databasePassword,
      databaseAppPassword: config.secrets.databaseAppPassword,
    },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** The parsed config, or null when the file does not exist. */
export async function readConfig(path: string): Promise<AppConfig | null> {
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(
      "unreadable",
      `config.json could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"}).`,
    );
  }
  return parseConfig(text);
}

export async function writeConfig(
  path: string,
  config: AppConfig,
): Promise<void> {
  await writeFileAtomic(path, Buffer.from(serializeConfig(config), "utf8"));
}

/**
 * Replace the `lan` block on disk and nothing else: the toggle and the mDNS
 * claim write here while the stack runs. Re-reads the file first, so a port
 * move written by this launch's bootstrap is kept. Returns the config written.
 */
export async function writeLanSettings(
  path: string,
  lan: LanSettings,
): Promise<AppConfig> {
  const current = await readConfig(path);
  if (current === null) {
    throw new ConfigError(
      "unreadable",
      "config.json is missing, so the local-network setting cannot be saved.",
    );
  }
  const next: AppConfig = { ...current, lan };
  await writeConfig(path, next);
  return next;
}
