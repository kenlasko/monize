import { isFromAppPage } from "./ipc-sender";

describe("isFromAppPage", () => {
  const origin = "http://127.0.0.1:43123";
  const contents = { id: 1 };

  it("accepts the main window's page on the app's origin", () => {
    expect(
      isFromAppPage(
        { sender: contents, frameUrl: `${origin}/accounts` },
        contents,
        origin,
      ),
    ).toBe(true);
  });

  it("refuses another window's page, even on the app's origin", () => {
    expect(
      isFromAppPage(
        { sender: { id: 2 }, frameUrl: `${origin}/` },
        contents,
        origin,
      ),
    ).toBe(false);
  });

  it("refuses a frame on another origin", () => {
    expect(
      isFromAppPage(
        { sender: contents, frameUrl: "https://example.com/" },
        contents,
        origin,
      ),
    ).toBe(false);
    expect(
      isFromAppPage(
        { sender: contents, frameUrl: "http://127.0.0.1:43124/" },
        contents,
        origin,
      ),
    ).toBe(false);
  });

  it("refuses an unknown frame and a closed window", () => {
    expect(
      isFromAppPage({ sender: contents, frameUrl: "" }, contents, origin),
    ).toBe(false);
    expect(
      isFromAppPage({ sender: null, frameUrl: `${origin}/` }, null, origin),
    ).toBe(false);
  });
});
