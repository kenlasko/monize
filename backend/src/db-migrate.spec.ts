import * as fs from "fs";

// Mock pg Client
const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockEnd = jest.fn();

jest.mock("pg", () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    query: mockQuery,
    end: mockEnd,
  })),
}));

// Mock process.exit to prevent test runner from dying
const mockExit = jest
  .spyOn(process, "exit")
  .mockImplementation((() => {}) as any);

import { runMigrations } from "./db-migrate";

describe("db-migrate runMigrations()", () => {
  let existsSyncSpy: jest.SpyInstance;
  let statSyncSpy: jest.SpyInstance;
  let readdirSyncSpy: jest.SpyInstance;
  let readFileSyncSpy: jest.SpyInstance;
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);

    consoleSpy = jest.spyOn(console, "log").mockImplementation();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();

    // Default: no migrations directory found
    existsSyncSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
    statSyncSpy = jest
      .spyOn(fs, "statSync")
      .mockReturnValue({ isDirectory: () => true } as any);
    readdirSyncSpy = jest.spyOn(fs, "readdirSync").mockReturnValue([] as any);
    readFileSyncSpy = jest.spyOn(fs, "readFileSync").mockReturnValue("");
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    statSyncSpy.mockRestore();
    readdirSyncSpy.mockRestore();
    readFileSyncSpy.mockRestore();
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("skips when no migrations directory is found", async () => {
    existsSyncSpy.mockReturnValue(false);

    await runMigrations();

    expect(consoleSpy).toHaveBeenCalledWith(
      "No migrations directory found. Skipping migrations.",
    );
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS"),
    );
  });

  it("creates schema_migrations table on startup", async () => {
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue([]);
    mockQuery
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }); // SELECT applied

    await runMigrations();

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS schema_migrations"),
    );
  });

  it("skips already-applied migrations", async () => {
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue([
      "001_init.sql",
      "002_add_users.sql",
    ] as any);
    mockQuery
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({
        rows: [{ filename: "001_init.sql" }, { filename: "002_add_users.sql" }],
      }); // SELECT applied

    await runMigrations();

    expect(consoleSpy).toHaveBeenCalledWith(
      "Database is up to date. No pending migrations.",
    );
    // Should NOT have called BEGIN (no migrations to apply)
    expect(mockQuery).not.toHaveBeenCalledWith("BEGIN");
  });

  it("applies pending migrations in order", async () => {
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue([
      "001_init.sql",
      "002_add_users.sql",
    ] as any);
    readFileSyncSpy.mockImplementation((filePath: string) => {
      if (filePath.includes("001_init.sql")) return "CREATE TABLE t1();";
      if (filePath.includes("002_add_users.sql")) return "CREATE TABLE t2();";
      return "";
    });

    mockQuery
      .mockResolvedValueOnce(undefined) // CREATE TABLE schema_migrations
      .mockResolvedValueOnce({ rows: [] }) // SELECT applied (none)
      .mockResolvedValue(undefined); // All subsequent queries succeed

    await runMigrations();

    // Verify BEGIN/SQL/INSERT/COMMIT pattern for each migration
    const calls = mockQuery.mock.calls.map((c) => c[0]);
    expect(calls).toContain("BEGIN");
    expect(calls).toContain("CREATE TABLE t1();");
    expect(calls).toContain("CREATE TABLE t2();");
    expect(calls).toContain("COMMIT");

    // Should have recorded both migrations
    expect(mockQuery).toHaveBeenCalledWith(
      "INSERT INTO schema_migrations (filename) VALUES ($1)",
      ["001_init.sql"],
    );
    expect(mockQuery).toHaveBeenCalledWith(
      "INSERT INTO schema_migrations (filename) VALUES ($1)",
      ["002_add_users.sql"],
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      "Applied 2 migration(s) successfully.",
    );
  });

  it("applies only pending migrations (skips already-applied)", async () => {
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue([
      "001_init.sql",
      "002_add_users.sql",
      "003_add_prefs.sql",
    ] as any);
    readFileSyncSpy.mockReturnValue("SELECT 1;");

    mockQuery
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({
        rows: [{ filename: "001_init.sql" }, { filename: "002_add_users.sql" }],
      }) // SELECT applied (first two already done)
      .mockResolvedValue(undefined); // All subsequent queries succeed

    await runMigrations();

    // Only the third migration should be applied
    expect(mockQuery).toHaveBeenCalledWith(
      "INSERT INTO schema_migrations (filename) VALUES ($1)",
      ["003_add_prefs.sql"],
    );
    expect(mockQuery).not.toHaveBeenCalledWith(
      "INSERT INTO schema_migrations (filename) VALUES ($1)",
      ["001_init.sql"],
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      "Applied 1 migration(s) successfully.",
    );
  });

  it("rolls back and exits on migration failure", async () => {
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue(["001_bad.sql"] as any);
    readFileSyncSpy.mockReturnValue("INVALID SQL;");

    mockQuery
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }) // SELECT applied
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error("syntax error")) // SQL fails
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await runMigrations();

    expect(mockQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Migration 001_bad.sql failed:",
      expect.any(Error),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exits on connection failure", async () => {
    mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

    await runMigrations();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Migration runner failed:",
      expect.any(Error),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("filters non-.sql files from migrations directory", async () => {
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue([
      "001_init.sql",
      "README.md",
      ".gitkeep",
    ] as any);
    readFileSyncSpy.mockReturnValue("SELECT 1;");

    mockQuery
      .mockResolvedValueOnce(undefined) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [] }) // SELECT applied
      .mockResolvedValue(undefined); // All subsequent queries succeed

    await runMigrations();

    // Only 001_init.sql should be applied (not README.md or .gitkeep)
    expect(mockQuery).toHaveBeenCalledWith(
      "INSERT INTO schema_migrations (filename) VALUES ($1)",
      ["001_init.sql"],
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      "Applied 1 migration(s) successfully.",
    );
  });

  it("always closes the client connection", async () => {
    existsSyncSpy.mockReturnValue(false);

    await runMigrations();

    expect(mockEnd).toHaveBeenCalled();
  });

  it("closes connection even after failure", async () => {
    mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

    await runMigrations();

    expect(mockEnd).toHaveBeenCalled();
  });
});
