import { RunnerContext } from "./postgres-context";
import { messageOf } from "./postgres-errors";
import { PgSession } from "./postgres-types";

/**
 * The last step of a start: prove the server takes an authenticated TCP
 * connection, and make sure the application database exists.
 *
 * `backend/src/db-init.ts` connects to the application database and never
 * runs CREATE DATABASE, so the database has to be here before it runs. The
 * check runs on every start rather than once after initdb, so a shell that
 * died between initdb and CREATE DATABASE is repaired by the next launch.
 * Extensions are not created here: `database/schema.sql` creates them.
 */

const CONNECT_PAUSE_MS = 250;
const CONNECT_TIMEOUT_MS = 5000;
/** invalid_password, invalid_authorization_specification. */
const AUTH_FAILURES = new Set(["28P01", "28000"]);

function codeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { code: unknown };
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

async function connectWhenReady(context: RunnerContext): Promise<PgSession> {
  const { deps, options, timeouts } = context;
  const deadline = deps.now().getTime() + timeouts.readySeconds * 1000;
  for (;;) {
    try {
      return await deps.connect({
        host: "127.0.0.1",
        port: options.port,
        user: options.superuser,
        password: options.password,
        database: "postgres",
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
      });
    } catch (error) {
      if (AUTH_FAILURES.has(codeOf(error) ?? "")) {
        throw context.failure(
          "auth",
          `The database server on 127.0.0.1:${options.port} rejected the stored password for ${options.superuser}. The data directory ${options.dataDir} was created with a different one.`,
          messageOf(error),
        );
      }
      if (deps.now().getTime() >= deadline) {
        throw context.failure(
          "ready",
          `The database server started but took no connection on 127.0.0.1:${options.port} within ${timeouts.readySeconds} seconds.`,
          messageOf(error),
        );
      }
      await deps.sleep(CONNECT_PAUSE_MS);
    }
  }
}

export async function ensureDatabase(context: RunnerContext): Promise<void> {
  const { options } = context;
  const session = await connectWhenReady(context);
  try {
    await session.query("SELECT 1");
    const existing = await session.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [options.database],
    );
    if (existing.rows.length === 0) {
      // Both names passed the identifier check in createContext, and CREATE
      // DATABASE takes no parameters.
      await session.query(
        `CREATE DATABASE "${options.database}" OWNER "${options.superuser}"`,
      );
      context.log(`postgres: created the database ${options.database}`);
    }
  } catch (error) {
    throw context.failure(
      "database",
      `The database server is running but the database ${options.database} could not be checked or created.`,
      messageOf(error),
    );
  } finally {
    await session.end().catch(() => undefined);
  }
}
