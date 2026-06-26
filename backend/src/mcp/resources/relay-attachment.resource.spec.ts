import { McpRelayAttachmentResource } from "./relay-attachment.resource";
import { RelayAttachmentStore } from "../../ai/relay/relay-attachment.store";
import { UserContextResolver } from "../mcp-context";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const CSV_BASE64 = Buffer.from("a,b\n1,2\n").toString("base64");

// The handler only reads `uri.href`, so a light stub suffices.
const uriFor = (id: string) => ({ href: `monize-attachment://${id}` }) as any;

describe("McpRelayAttachmentResource", () => {
  let store: RelayAttachmentStore;
  let resource: McpRelayAttachmentResource;
  let server: { registerResource: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  let handler: (...args: any[]) => any;

  beforeEach(() => {
    store = new RelayAttachmentStore();
    resource = new McpRelayAttachmentResource(store);
    server = {
      registerResource: jest.fn((_name, _template, _opts, h) => {
        handler = h;
      }),
    };
    resolve = jest.fn();
    resource.register(server as any, resolve);
  });

  it("registers a templated resource", () => {
    expect(server.registerResource).toHaveBeenCalledWith(
      "relay-attachment",
      expect.any(Object),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns an error when there is no user context", async () => {
    resolve.mockReturnValue(undefined);
    const result = await handler(uriFor("x"), { id: "x" }, { sessionId: "s1" });
    expect(result.contents[0].text).toContain("Error");
  });

  it("returns an error when the read scope is missing", async () => {
    resolve.mockReturnValue({ userId: "u1", scopes: "write" });
    const result = await handler(uriFor("x"), { id: "x" }, { sessionId: "s1" });
    expect(result.contents[0].text).toContain("Insufficient scope");
  });

  it("returns a not-found error for an unknown or expired id", async () => {
    resolve.mockReturnValue({ userId: "u1", scopes: "read" });
    const result = await handler(
      uriFor("nope"),
      { id: "nope" },
      { sessionId: "s1" },
    );
    expect(result.contents[0].text).toContain("not found or expired");
  });

  it("returns a base64 blob for an image attachment", async () => {
    const [ref] = store.store("u1", [
      {
        kind: "image",
        mediaType: "image/png",
        filename: "i.png",
        data: PNG_BASE64,
      },
    ]);
    resolve.mockReturnValue({ userId: "u1", scopes: "read" });

    const result = await handler(
      uriFor(ref.id),
      { id: ref.id },
      { sessionId: "s1" },
    );
    expect(result.contents[0].mimeType).toBe("image/png");
    expect(result.contents[0].blob).toBe(PNG_BASE64);
    expect(result.contents[0].text).toBeUndefined();
  });

  it("returns text for a text attachment", async () => {
    const [ref] = store.store("u1", [
      {
        kind: "text",
        mediaType: "text/csv",
        filename: "r.csv",
        data: CSV_BASE64,
      },
    ]);
    resolve.mockReturnValue({ userId: "u1", scopes: "read" });

    const result = await handler(
      uriFor(ref.id),
      { id: ref.id },
      { sessionId: "s1" },
    );
    expect(result.contents[0].mimeType).toBe("text/csv");
    expect(result.contents[0].text).toBe("a,b\n1,2\n");
    expect(result.contents[0].blob).toBeUndefined();
  });

  it("does not let one user read another user's attachment", async () => {
    const [ref] = store.store("u1", [
      {
        kind: "image",
        mediaType: "image/png",
        filename: "i.png",
        data: PNG_BASE64,
      },
    ]);
    // A different user is resolved from the session; the id belongs to u1.
    resolve.mockReturnValue({ userId: "u2", scopes: "read" });

    const result = await handler(
      uriFor(ref.id),
      { id: ref.id },
      { sessionId: "s2" },
    );
    expect(result.contents[0].text).toContain("not found or expired");
    expect(result.contents[0].blob).toBeUndefined();
  });
});
