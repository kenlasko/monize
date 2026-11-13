import { fakeSpawner } from "../test-support/fake-process";
import { memoryLogger } from "../test-support/memory-logger";
import { createChildLauncher } from "./child";
import { FRONTEND_SERVER_ARGS, startFrontendServer } from "./frontend";

describe("startFrontendServer", () => {
  it("starts server.js behind the log formatter, in the frontend directory, logging as the frontend", () => {
    const spawner = fakeSpawner();
    const logger = memoryLogger();
    const launch = createChildLauncher({
      execPath: "/opt/monize/Monize",
      logger,
      spawn: spawner.spawn,
    });

    const handle = startFrontendServer(launch, {
      cwd: "/res/frontend",
      env: { PORT: "3380" },
    });

    const [spawned] = spawner.processes;
    expect(spawned.command).toBe("/opt/monize/Monize");
    expect(spawned.args).toEqual([
      "--require",
      "./server-log-format.cjs",
      "server.js",
    ]);
    expect(spawned.args).toEqual(FRONTEND_SERVER_ARGS);
    expect(spawned.options.cwd).toBe("/res/frontend");
    expect(spawned.options.env).toEqual({ PORT: "3380" });
    expect(handle.pid).toBe(spawned.pid);

    spawned.stdout.emit("data", "Ready in 300ms\n");
    expect(logger.messages("frontend")).toEqual(["Ready in 300ms"]);
  });
});
