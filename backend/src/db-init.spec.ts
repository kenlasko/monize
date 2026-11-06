import fs from "fs";
import { Logger } from "@nestjs/common";
import { NAMED_ROLE_FACTS_SQL } from "./common/db/runtime-role-check";
import { DEFAULT_APP_USER } from "./common/db/rls-config";

// Mock pg Client
const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockEnd = jest.fn();
const mockOn = jest.fn();

jest.mock("pg", () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    query: mockQuery,
    end: mockEnd,
    on: mockOn,
  })),
}));

// Mock process.exit to prevent test runner from dying
const mockExit = jest
  .spyOn(process, "exit")
  .mockImplementation((() => {}) as any);

import { initDatabase } from "./db-init";

/** A safe named-role facts row, in the `{ rows }` shape pg returns. */
const SAFE_ROLE_ROW = {
  current_user_name: DEFAULT_APP_USER,
  rolsuper: false,
  rolbypassrls: false,
  rolreplication: false,
  rolcreaterole: false,
  rolcreatedb: false,
  owns_database: false,
  owned_policied_tables: "0",
  exempt_reachable_contexts: [],
  inherited_owner_roles: [],
  inherited_forbidden_roles: [],
};

/**
 * Answer queries by content rather than by position, so the assertions here
 * survive a reordering that keeps behavior and fail on one that does not.
 */
function primeQueries(options: {
  usersExist: boolean;
  roleRow?: Record<string, unknown> | null;
}) {
  mockQuery.mockImplementation((text: string) => {
    if (typeof text === "string" && text.includes("SELECT EXISTS")) {
      return Promise.resolve({ rows: [{ exists: options.usersExist }] });
    }
    if (typeof text === "string" && text.includes("WHERE r.rolname = $1")) {
      return Promise.resolve({
        rows: options.roleRow ? [options.roleRow] : [],
      });
    }
    return Promise.resolve({ rows: [] });
  });
}

// The real implementations, captured before any spy replaces them.
const realExistsSync = fs.existsSync;
const realReadFileSync = fs.readFileSync;

/** A path to the schema file `initDatabase` looks for, in any search directory. */
function isSchemaPath(p: unknown): boolean {
  return typeof p === "string" && p.endsWith("schema.sql");
}

describe("db-init initDatabase()", () => {
  const SCHEMA_SQL = "CREATE TABLE users ();";
  let existsSyncSpy: jest.SpyInstance;
  let readFileSyncSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);

    savedEnv = {
      DATABASE_USER: process.env.DATABASE_USER,
      DATABASE_PASSWORD: process.env.DATABASE_PASSWORD,
      DATABASE_NAME: process.env.DATABASE_NAME,
      DATABASE_APP_USER: process.env.DATABASE_APP_USER,
      DATABASE_APP_PASSWORD: process.env.DATABASE_APP_PASSWORD,
      RLS_MODE: process.env.RLS_MODE,
    };
    process.env.DATABASE_USER = "monize";
    process.env.DATABASE_PASSWORD = "owner-pw";
    process.env.DATABASE_NAME = "monize";
    delete process.env.DATABASE_APP_USER;
    delete process.env.DATABASE_APP_PASSWORD;
    delete process.env.RLS_MODE;

    // The initializer logs through the Nest Logger so its output matches the
    // rest of the boot sequence; spying on console here would catch nothing.
    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation();

    // Only the schema file is faked. Jest itself reads through `fs` (a source
    // map, when it formats an error's stack), and a blanket stub handed it
    // SCHEMA_SQL to parse: "SyntaxError: Unexpected identifier 'TABLE'" from
    // convert-source-map, in whichever test first formatted a stack.
    existsSyncSpy = jest
      .spyOn(fs, "existsSync")
      .mockImplementation((p) => isSchemaPath(p) || realExistsSync(p));
    readFileSyncSpy = jest
      .spyOn(fs, "readFileSync")
      .mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) =>
        isSchemaPath(p)
          ? SCHEMA_SQL
          : (realReadFileSync as (...a: unknown[]) => unknown)(
              p,
              ...rest,
            )) as typeof fs.readFileSync);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    existsSyncSpy.mockRestore();
    readFileSyncSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("forwards Postgres notices to the logger", async () => {
    // The insufficient-privilege warnings the provisioning DO blocks raise
    // arrive as notice events; without this handler they would vanish.
    primeQueries({ usersExist: true });

    await initDatabase();

    expect(mockOn).toHaveBeenCalledWith("notice", expect.any(Function));
    const handler = mockOn.mock.calls.find((c) => c[0] === "notice")![1];
    handler({ message: "Insufficient privilege to create/alter role x" });
    expect(warnSpy).toHaveBeenCalledWith(
      "Postgres: Insufficient privilege to create/alter role x",
    );
  });

  it("takes the lifecycle lock before asking whether tables exist", async () => {
    // The check-then-act race this lock exists for: a follower must run its
    // "already initialized?" check after the winner finishes, not alongside it.
    primeQueries({ usersExist: true });

    await initDatabase();

    const calls = mockQuery.mock.calls.map((c) => c[0] as string);
    const lockAt = calls.findIndex((t) => t.includes("pg_advisory_lock"));
    const existsAt = calls.findIndex((t) => t.includes("SELECT EXISTS"));
    expect(lockAt).toBeGreaterThan(-1);
    expect(existsAt).toBeGreaterThan(lockAt);
  });

  it("provisions the runtime role on every startup, even when tables exist", async () => {
    // Placed before the early skip on purpose: password rotation and grant
    // re-application must run on an already-initialized database.
    primeQueries({ usersExist: true });

    await initDatabase();

    const calls = mockQuery.mock.calls.map((c) => c[0] as string);
    expect(calls.some((t) => t.includes("GRANT USAGE ON SCHEMA public"))).toBe(
      true,
    );
    expect(logSpy).toHaveBeenCalledWith(
      "Database tables already exist; skipping initialization",
    );
  });

  it("applies schema.sql when the users table is missing", async () => {
    primeQueries({ usersExist: false });

    await initDatabase();

    expect(mockQuery).toHaveBeenCalledWith(SCHEMA_SQL);
    expect(logSpy).toHaveBeenCalledWith("Database initialized successfully");
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("exits when schema.sql cannot be found", async () => {
    primeQueries({ usersExist: false });
    existsSyncSpy.mockImplementation(
      (p) => !isSchemaPath(p) && realExistsSync(p),
    );

    await initDatabase();

    const report = errorSpy.mock.calls.flat().join("\n");
    expect(report).toContain("schema.sql not found");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("does not ask about role safety at off or shadow", async () => {
    // Those modes connect as the owner deliberately; the configured role may
    // legitimately not exist yet.
    primeQueries({ usersExist: true });

    await initDatabase();

    const calls = mockQuery.mock.calls.map((c) => c[0] as string);
    expect(calls.some((t) => t.includes("WHERE r.rolname = $1"))).toBe(false);
  });

  it("verifies the configured role under enforce, after the schema work", async () => {
    // After, not before: asked first, the ownership arms interrogate an empty
    // database and can only pass trivially (PR #1076 review). The assertion is
    // on the order of the actual queries, so moving the call back fails it.
    process.env.RLS_MODE = "enforce";
    primeQueries({ usersExist: false, roleRow: SAFE_ROLE_ROW });

    await initDatabase();

    const calls = mockQuery.mock.calls.map((c) => c[0] as string);
    const schemaAt = calls.indexOf(SCHEMA_SQL);
    const roleCheckAt = calls.findIndex((t) =>
      t.includes("WHERE r.rolname = $1"),
    );
    expect(schemaAt).toBeGreaterThan(-1);
    expect(roleCheckAt).toBeGreaterThan(schemaAt);
    expect(
      mockQuery.mock.calls.find((c) =>
        (c[0] as string).includes("WHERE r.rolname = $1"),
      )![1],
    ).toEqual([DEFAULT_APP_USER]);
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("uses the same query the runtime check uses, by its exported text", async () => {
    // One classifier: db-init must ask the exact NAMED_ROLE_FACTS_SQL that
    // runtime-role-check.ts exports, not a local rephrasing of it.
    process.env.RLS_MODE = "enforce";
    primeQueries({ usersExist: true, roleRow: SAFE_ROLE_ROW });

    await initDatabase();

    expect(mockQuery).toHaveBeenCalledWith(NAMED_ROLE_FACTS_SQL, [
      DEFAULT_APP_USER,
    ]);
  });

  it("exits under enforce when the configured role is unsafe, naming the reason", async () => {
    // The verdict-parity regression at the process level: CREATEDB was a
    // warning in the checker this replaced, while the runtime check refuses
    // it -- db-init blessed a role that main.ts then rejected.
    process.env.RLS_MODE = "enforce";
    primeQueries({
      usersExist: true,
      roleRow: { ...SAFE_ROLE_ROW, rolcreatedb: true },
    });

    await initDatabase();

    const report = errorSpy.mock.calls.flat().join("\n");
    expect(report).toContain("CREATEDB");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits under enforce when the configured role does not exist", async () => {
    process.env.RLS_MODE = "enforce";
    primeQueries({ usersExist: true, roleRow: null });

    await initDatabase();

    const report = errorSpy.mock.calls.flat().join("\n");
    expect(report).toContain(
      `requires the runtime role '${DEFAULT_APP_USER}' to exist`,
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits when a required environment variable is missing", async () => {
    delete process.env.DATABASE_USER;
    primeQueries({ usersExist: true });

    await initDatabase();

    const report = errorSpy.mock.calls.flat().join("\n");
    expect(report).toContain(
      "Missing required environment variable: DATABASE_USER",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("always closes the client connection", async () => {
    primeQueries({ usersExist: true });

    await initDatabase();

    expect(mockEnd).toHaveBeenCalled();
  });

  it("closes the connection even after a failure", async () => {
    mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

    await initDatabase();

    expect(mockEnd).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
