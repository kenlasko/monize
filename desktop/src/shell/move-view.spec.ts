import { formatBytes, moveProgressView, percentOf } from "./move-view";
import { TEXT } from "./strings";

describe("the move's progress in the splash", () => {
  it("formats sizes in binary units", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(1023)).toBe("1023 bytes");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1.4 * 1024 ** 3)).toBe("1.4 GB");
    expect(formatBytes(5 * 1024 ** 5)).toBe("5120.0 TB");
  });

  it("bounds the percentage", () => {
    const at = (doneBytes: number, totalBytes: number) =>
      percentOf({ phase: "copying", doneBytes, totalBytes });
    expect(at(0, 0)).toBe(0);
    expect(at(1, 3)).toBe(33);
    expect(at(5, 3)).toBe(100);
  });

  it("shows how far the copy is, with no way to quit from the window", () => {
    const view = moveProgressView({
      phase: "copying",
      doneBytes: 512 * 1024,
      totalBytes: 1024 * 1024,
    });
    expect(view).toMatchObject({
      title: TEXT.move.progressTitle,
      busy: true,
      canQuit: false,
      canRetry: false,
      lines: [],
      progress: 0.5,
    });
    expect(view.detail).toContain("512.0 KB of 1.0 MB (50%)");
    expect(view.detail).toContain(TEXT.move.progressKeepOpen);
  });

  it("shows only the phase when there is nothing to count", () => {
    const view = moveProgressView({
      phase: "stopping",
      doneBytes: 0,
      totalBytes: 0,
    });
    expect(view.detail).toBe(TEXT.move.phase.stopping);
    // The bar runs without a fill rather than claiming 0%.
    expect(view.progress).toBeNull();
  });
});
