import { promises as fs } from "fs";

import { writeFileAtomic } from "./atomic-write";
import { isValidPort, PORT_NAMES, Ports } from "./ports";
import { StoredSecret } from "./secrets";

/**
 * `config.json`, the file under the data directory that holds the ports and
 * the wrapped secrets.
 *
 * Read strictly: an unknown version, a missing key, an extra key or a value of
 * the wrong type is a `ConfigError`, never a default. A default here would be
 * a regenerated secret or a new origin, which is the damage plan D7 and D8
 * exist to prevent. The data directory itself is not recorded: a pointer kept
 * inside the directory it points to cannot help anyone find that directory.
 */

export const CONFIG_VERSION = 1;

export const SECRET_NAMES = [
  "jwtSecret",
  "encryptionKey",
  "databasePassword",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export type StoredSecrets = Readonly<Record<SecretName, StoredSecret>>;
export type PlainSecrets = Readonly<Record<SecretName, string>>;

export interface AppConfig {
  readonly version: typeof CONFIG_VERSION;
  readonly ports: Ports;
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
  };
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
  if (data.version !== CONFIG_VERSION) {
    throw new ConfigError(
      "unsupported-version",
      `config.json has version ${JSON.stringify(data.version)}; this build ` +
        `reads version ${CONFIG_VERSION} only.`,
    );
  }
  const raw = exactKeys(data, "the top level", ["version", "ports", "secrets"]);
  return {
    version: CONFIG_VERSION,
    ports: parsePorts(raw.ports),
    secrets: parseSecrets(raw.secrets),
  };
}

export function serializeConfig(config: AppConfig): string {
  const ordered: AppConfig = {
    version: config.version,
    ports: {
      frontend: config.ports.frontend,
      backend: config.ports.backend,
      postgres: config.ports.postgres,
    },
    secrets: {
      jwtSecret: config.secrets.jwtSecret,
      encryptionKey: config.secrets.encryptionKey,
      databasePassword: config.secrets.databasePassword,
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
