import { promises as fs } from "fs";

import {
  AppConfig,
  CONFIG_VERSION,
  ConfigError,
  PlainSecrets,
  readConfig,
  SECRET_NAMES,
  StoredSecrets,
  writeConfig,
} from "./app-config";
import { DataPaths } from "./app-paths";
import { PortName, PortProber, probePort, resolvePorts } from "./ports";
import {
  generateSecret,
  SecretPolicy,
  unwrapSecret,
  wrapSecret,
} from "./secrets";

/**
 * Load `config.json`, or create it on a genuine first run (plan D7).
 *
 * Fails closed. A first run is a missing `config.json` AND a missing or empty
 * `pgdata`. Anything else that lacks a usable config is a damaged install and
 * throws a typed error naming what is wrong, because regenerating would be
 * worse than stopping: a new `ENCRYPTION_KEY` cannot open a single encrypted
 * column, and a new `DATABASE_PASSWORD` locks the app out of its own cluster.
 */

export interface BootstrapOptions {
  readonly paths: DataPaths;
  readonly policy: SecretPolicy;
  readonly probe?: PortProber;
  readonly generate?: () => string;
}

export interface BootstrapResult {
  readonly config: AppConfig;
  readonly secrets: PlainSecrets;
  readonly firstRun: boolean;
  /** Persisted ports that were busy and have moved; the origin may differ. */
  readonly movedPorts: readonly PortName[];
}

async function hasContent(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Create the data directory tree. `pgdata` is owner-only, as initdb wants. */
export async function ensureDataDirs(paths: DataPaths): Promise<void> {
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.mkdir(paths.pgdata, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.backups, { recursive: true });
  await fs.mkdir(paths.attachments, { recursive: true });
  await fs.mkdir(paths.logs, { recursive: true });
}

function unwrapAll(stored: StoredSecrets, policy: SecretPolicy): PlainSecrets {
  return {
    jwtSecret: unwrapSecret(stored.jwtSecret, "jwtSecret", policy),
    encryptionKey: unwrapSecret(stored.encryptionKey, "encryptionKey", policy),
    databasePassword: unwrapSecret(
      stored.databasePassword,
      "databasePassword",
      policy,
    ),
    databaseAppPassword: unwrapSecret(
      stored.databaseAppPassword,
      "databaseAppPassword",
      policy,
    ),
  };
}

function wrapAll(plain: PlainSecrets, policy: SecretPolicy): StoredSecrets {
  return {
    jwtSecret: wrapSecret(plain.jwtSecret, "jwtSecret", policy),
    encryptionKey: wrapSecret(plain.encryptionKey, "encryptionKey", policy),
    databasePassword: wrapSecret(
      plain.databasePassword,
      "databasePassword",
      policy,
    ),
    databaseAppPassword: wrapSecret(
      plain.databaseAppPassword,
      "databaseAppPassword",
      policy,
    ),
  };
}

async function createFirstRun(
  options: BootstrapOptions,
  probe: PortProber,
): Promise<BootstrapResult> {
  const { paths, policy } = options;
  const generate = options.generate ?? (() => generateSecret());
  const secrets: PlainSecrets = {
    jwtSecret: generate(),
    encryptionKey: generate(),
    databasePassword: generate(),
    databaseAppPassword: generate(),
  };
  if (
    new Set(SECRET_NAMES.map((name) => secrets[name])).size !==
    SECRET_NAMES.length
  ) {
    throw new Error("Secret generation returned the same value twice.");
  }
  // Wrap before touching the disk, so a refusal (no OS encryption and no
  // MONIZE_INSECURE_SECRETS) leaves no half-created install behind.
  const stored = wrapAll(secrets, policy);
  const { ports } = await resolvePorts(null, probe);
  await ensureDataDirs(paths);
  const config: AppConfig = { version: CONFIG_VERSION, ports, secrets: stored };
  await writeConfig(paths.configFile, config);
  return { config, secrets, firstRun: true, movedPorts: [] };
}

export async function loadOrCreateConfig(
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  const { paths, policy } = options;
  const probe = options.probe ?? probePort;
  const existing = await readConfig(paths.configFile);

  if (existing === null) {
    if (await hasContent(paths.pgdata)) {
      throw new ConfigError(
        "damaged-install",
        `config.json is missing from ${paths.dataDir}, but the database ` +
          `folder ${paths.pgdata} holds data. The secrets that open that ` +
          "database were in config.json, so new ones cannot be generated " +
          "without losing it. Restore config.json from a copy, or move the " +
          "data folder aside to start empty.",
      );
    }
    return createFirstRun(options, probe);
  }

  const secrets = unwrapAll(existing.secrets, policy);
  await ensureDataDirs(paths);
  const resolution = await resolvePorts(existing.ports, probe);
  const config: AppConfig = resolution.changed
    ? { ...existing, ports: resolution.ports }
    : existing;
  if (resolution.changed) {
    await writeConfig(paths.configFile, config);
  }
  return { config, secrets, firstRun: false, movedPorts: resolution.moved };
}
