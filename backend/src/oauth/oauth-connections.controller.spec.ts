import { BadRequestException } from "@nestjs/common";
import { OAuthConnectionsController } from "./oauth-connections.controller";
import type { OAuthConnectionsService } from "./oauth-connections.service";
import { ParseOAuthGrantIdPipe } from "./parse-oauth-grant-id.pipe";

describe("OAuthConnectionsController", () => {
  const USER = "11111111-1111-1111-1111-111111111111";

  it("lists and revokes for the session's own user id", async () => {
    const connections = {
      list: jest.fn().mockResolvedValue([{ id: "g" }]),
      revoke: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new OAuthConnectionsController(
      connections as unknown as OAuthConnectionsService,
    );
    const req = { user: { id: USER } };

    await expect(controller.list(req)).resolves.toEqual([{ id: "g" }]);
    await expect(controller.revoke(req, "g")).resolves.toBeUndefined();
    expect(connections.list).toHaveBeenCalledWith(USER);
    expect(connections.revoke).toHaveBeenCalledWith(USER, "g");
  });
});

describe("ParseOAuthGrantIdPipe", () => {
  const pipe = new ParseOAuthGrantIdPipe();

  it("accepts a provider nanoid", () => {
    const id = "aB3_-".repeat(8) + "xyz";
    expect(pipe.transform(id)).toBe(id);
  });

  it.each([
    ["an empty string", ""],
    ["a value over the column width", "a".repeat(256)],
    ["SQL punctuation", "g' OR '1'='1"],
    ["a path segment", "../grant"],
    ["a repeated query key's array", ["a", "b"]],
    ["a number", 42],
  ])("refuses %s", (_label, value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });
});
