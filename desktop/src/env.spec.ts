import { dataPathsFor } from "./app-paths";
import {
  ChildEnvConfig,
  ChildEnvError,
  composeBackendEnv,
  composeFrontendEnv,
  INHERITED_ENV,
} from "./env";
import { generateSecret } from "./secrets";

/**
 * The guard plan section 8 asks for: whatever the parent environment says,
 * the children bind loopback, use the frontend origin, never phone home for
 * updates, run in UTC as production, and never start with an empty secret.
 */

const CONFIG: ChildEnvConfig = {
  ports: { frontend: 4380, backend: 4381, postgres: 6433 },
  secrets: {
    jwtSecret: generateSecret(),
    encryptionKey: generateSecret(),
    databasePassword: generateSecret(),
  },
};
const PATHS = dataPathsFor("C:\\Users\\a\\AppData\\Local\\Monize", "win32");

const HOSTILE: Record<string, string> = {
  HOST: "0.0.0.0",
  HOSTNAME: "0.0.0.0",
  host: "0.0.0.0",
  PORT: "80",
  PUBLIC_APP_URL: "https://evil.example",
  CORS_ORIGIN: "*",
  INTERNAL_API_URL: "http://evil.example",
  UPDATE_CHECK_ENABLED: "true",
  TZ: "America/New_York",
  NODE_ENV: "development",
  NODE_OPTIONS: "--require C:\\evil.js",
  DATABASE_HOST: "db.example",
  DATABASE_PASSWORD: "",
  JWT_SECRET: "",
  ENCRYPTION_KEY: "",
  ELECTRON_RUN_AS_NODE: "0",
  RLS_MODE: "off",
  Path: "C:\\Windows\\System32",
  SystemRoot: "C:\\Windows",
  TEMP: "C:\\Temp",
};

const backend = composeBackendEnv(CONFIG, PATHS, HOSTILE);
const frontend = composeFrontendEnv(CONFIG, HOSTILE);

describe("both children", () => {
  it.each([
    ["backend", backend],
    ["frontend", frontend],
  ])("%s binds loopback and runs as production Node in UTC", (_name, env) => {
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.HOSTNAME).toBe("127.0.0.1");
    expect(env.NODE_ENV).toBe("production");
    expect(env.TZ).toBe("UTC");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.DISABLE_HTTPS_HEADERS).toBe("true");
  });

  it.each([
    ["backend", backend],
    ["frontend", frontend],
  ])("%s inherits only the allowlisted parent variables", (_name, env) => {
    expect(env.Path).toBe("C:\\Windows\\System32");
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.TEMP).toBe("C:\\Temp");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.RLS_MODE).toBeUndefined();
    expect(env.host).toBeUndefined();
  });

  it("never lets an allowlisted name shadow an application variable", () => {
    const appKeys = new Set(
      [
        ...Object.keys(composeBackendEnv(CONFIG, PATHS, {})),
        ...Object.keys(composeFrontendEnv(CONFIG, {})),
      ].map((key) => key.toLowerCase()),
    );
    for (const name of INHERITED_ENV) {
      expect(appKeys.has(name.toLowerCase())).toBe(false);
    }
  });

  it("returns new objects and does not touch the parent env", () => {
    const parent = { PATH: "/usr/bin" };
    const env = composeFrontendEnv(CONFIG, parent);
    expect(env).not.toBe(parent);
    expect(parent).toEqual({ PATH: "/usr/bin" });
  });
});

describe("composeBackendEnv", () => {
  it("matches plan section 6", () => {
    expect(composeBackendEnv(CONFIG, PATHS, {})).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      TZ: "UTC",
      PORT: "4381",
      HOST: "127.0.0.1",
      HOSTNAME: "127.0.0.1",
      DATABASE_HOST: "127.0.0.1",
      DATABASE_PORT: "6433",
      DATABASE_USER: "monize",
      DATABASE_PASSWORD: CONFIG.secrets.databasePassword,
      DATABASE_NAME: "monize",
      JWT_SECRET: CONFIG.secrets.jwtSecret,
      ENCRYPTION_KEY: CONFIG.secrets.encryptionKey,
      PUBLIC_APP_URL: "http://127.0.0.1:4380",
      CORS_ORIGIN: "http://127.0.0.1:4380",
      DISABLE_HTTPS_HEADERS: "true",
      BACKUP_CONTAINER_DIR: "C:\\Users\\a\\AppData\\Local\\Monize\\backups",
      ATTACHMENT_CONTAINER_DIR:
        "C:\\Users\\a\\AppData\\Local\\Monize\\attachments",
      BACKUP_ALLOWED_ROOTS: "C:\\Users\\a\\AppData\\Local\\Monize\\backups",
      UPDATE_CHECK_ENABLED: "false",
    });
  });

  it("ignores hostile parent values for every key it owns", () => {
    expect(backend.PORT).toBe("4381");
    expect(backend.PUBLIC_APP_URL).toBe("http://127.0.0.1:4380");
    expect(backend.CORS_ORIGIN).toBe("http://127.0.0.1:4380");
    expect(backend.UPDATE_CHECK_ENABLED).toBe("false");
    expect(backend.DATABASE_HOST).toBe("127.0.0.1");
    expect(backend.JWT_SECRET).toBe(CONFIG.secrets.jwtSecret);
  });

  it.each(["jwtSecret", "encryptionKey", "databasePassword"] as const)(
    "refuses an empty %s",
    (name) => {
      const config = { ...CONFIG, secrets: { ...CONFIG.secrets, [name]: "" } };
      expect(() => composeBackendEnv(config, PATHS, {})).toThrow(ChildEnvError);
      const blank = {
        ...CONFIG,
        secrets: { ...CONFIG.secrets, [name]: "   " },
      };
      expect(() => composeBackendEnv(blank, PATHS, {})).toThrow(ChildEnvError);
    },
  );

  it("refuses a JWT_SECRET or ENCRYPTION_KEY below the backend's floor", () => {
    const short = {
      ...CONFIG,
      secrets: { ...CONFIG.secrets, encryptionKey: "a".repeat(31) },
    };
    expect(() => composeBackendEnv(short, PATHS, {})).toThrow(/ENCRYPTION_KEY/);
  });

  it("never quotes a secret in its refusal", () => {
    const secret = "s".repeat(20);
    const config = {
      ...CONFIG,
      secrets: { ...CONFIG.secrets, jwtSecret: secret },
    };
    expect(() => composeBackendEnv(config, PATHS, {})).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }),
    );
  });
});

describe("composeFrontendEnv", () => {
  it("matches plan section 6", () => {
    expect(composeFrontendEnv(CONFIG, {})).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      TZ: "UTC",
      PORT: "4380",
      HOST: "127.0.0.1",
      HOSTNAME: "127.0.0.1",
      INTERNAL_API_URL: "http://127.0.0.1:4381",
      DISABLE_HTTPS_HEADERS: "true",
    });
  });

  it("points INTERNAL_API_URL at the backend origin whatever the parent says", () => {
    expect(frontend.INTERNAL_API_URL).toBe("http://127.0.0.1:4381");
    expect(frontend.PORT).toBe("4380");
  });

  it("carries no secret", () => {
    const values = Object.values(frontend);
    for (const secret of Object.values(CONFIG.secrets)) {
      expect(values).not.toContain(secret);
    }
  });
});
