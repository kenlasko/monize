import {
  DEFAULT_CONTENT_SIZE,
  DESKTOP_LAYOUT_MIN_WIDTH,
  mainWindowContentSize,
} from "./window-size";

describe("mainWindowContentSize", () => {
  it("opens wider than the phone-layout breakpoint on a full HD screen", () => {
    const size = mainWindowContentSize({ width: 1920, height: 1040 });
    expect(size).toEqual(DEFAULT_CONTENT_SIZE);
    expect(size.width).toBeGreaterThanOrEqual(DESKTOP_LAYOUT_MIN_WIDTH);
  });

  it("keeps the page area at or above the breakpoint where the screen allows", () => {
    // 1366 x 768 at 100% scaling, taskbar at the bottom.
    const size = mainWindowContentSize({ width: 1366, height: 728 });
    expect(size.width).toBeGreaterThanOrEqual(DESKTOP_LAYOUT_MIN_WIDTH);
    expect(size.width + 16).toBeLessThanOrEqual(1366);
    expect(size.height + 40).toBeLessThanOrEqual(728);
  });

  it("fits a screen narrower than the breakpoint", () => {
    // 1366 x 768 at 125% scaling is 1093 x 614 device-independent pixels.
    expect(mainWindowContentSize({ width: 1093, height: 574 })).toEqual({
      width: 1077,
      height: 534,
    });
  });
});
