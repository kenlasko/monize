import { AppPathsError } from "../app-paths";
import { PortError } from "../ports";
import { SecretError } from "../secrets";
import { BootFailure, SUPERVISOR_STATUSES } from "../supervisor/types";
import {
  failedView,
  MAX_SPLASH_LINE_CHARS,
  MAX_SPLASH_LINES,
  preparingView,
  splashLines,
  startupErrorView,
  statusView,
} from "./splash-view";
import { STATUS_TEXT, TEXT } from "./strings";

describe("splash views", () => {
  it("has text for every supervisor status", () => {
    for (const status of SUPERVISOR_STATUSES) {
      expect(STATUS_TEXT[status].length).toBeGreaterThan(0);
      expect(statusView(status).title).toBe(STATUS_TEXT[status]);
    }
  });

  it("shows no actions while booting", () => {
    for (const view of [preparingView(), statusView("backend")]) {
      expect(view).toMatchObject({
        canRetry: false,
        canQuit: false,
        busy: true,
      });
      expect(view.lines).toEqual([]);
    }
  });

  it("names the failed step and its cause, with the log tail, Retry and Quit", () => {
    const failure: BootFailure = {
      step: "backend",
      cause: {
        kind: "timeout",
        deadlineMs: 120000,
        lastStatus: 503,
        lastError: null,
      },
      logSource: "backend",
      logTail: [
        {
          time: "2026-01-01T00:00:00.000Z",
          level: "error",
          source: "backend",
          msg: "<b>no</b>",
        },
      ],
    };
    const view = failedView(failure);
    expect(view.title).toBe(TEXT.bootFailedTitle);
    expect(view.detail).toContain(STATUS_TEXT.backend);
    expect(view.detail).toContain("HTTP 503");
    // Passed as text: the page renders it with textContent.
    expect(view.lines).toEqual([
      "2026-01-01T00:00:00.000Z [backend] ERROR: <b>no</b>",
    ]);
    expect(view).toMatchObject({
      canRetry: true,
      canQuit: true,
      busy: false,
      retryLabel: TEXT.retry,
      quitLabel: TEXT.quit,
    });
  });

  it("caps the number and the length of log lines", () => {
    const records = Array.from({ length: MAX_SPLASH_LINES + 10 }, (_, i) => ({
      time: "t",
      level: "info" as const,
      source: "main" as const,
      msg: `${i} ${"x".repeat(MAX_SPLASH_LINE_CHARS)}`,
    }));
    const lines = splashLines(records);
    expect(lines).toHaveLength(MAX_SPLASH_LINES);
    expect(lines[0].startsWith("t [main] INFO: 10 ")).toBe(true);
    expect(lines[0].length).toBe(MAX_SPLASH_LINE_CHARS + 3);
  });

  it.each([
    new PortError("Port 3380 and the next 100 are all in use."),
    new SecretError(
      "decrypt-failed",
      "jwtSecret",
      "The stored jwtSecret cannot be decrypted.",
    ),
    new AppPathsError("MONIZE_DATA_DIR must be an absolute path."),
  ])("shows a typed startup error as it is: %s", (error) => {
    const view = startupErrorView(error);
    expect(view.detail).toBe(error.message);
    expect(view).toMatchObject({ canRetry: false, canQuit: true });
  });

  it("introduces an unexpected startup error", () => {
    const view = startupErrorView(new Error("EACCES"));
    expect(view.detail).toBe(`${TEXT.startupErrorUnknown} EACCES`);
    expect(startupErrorView("odd").detail).toBe(
      `${TEXT.startupErrorUnknown} odd`,
    );
  });
});
