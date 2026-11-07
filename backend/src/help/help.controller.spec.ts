import { NotFoundException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Test, TestingModule } from "@nestjs/testing";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { HelpController } from "./help.controller";
import { HelpService } from "./help.service";
import { HelpManifest, HelpPage } from "./dto/help-response.dto";
import { HelpSearchQueryDto } from "./dto/help-search-query.dto";

describe("HelpController", () => {
  let controller: HelpController;
  let mockService: {
    getManifest: jest.Mock;
    getPage: jest.Mock;
    getImage: jest.Mock;
    search: jest.Mock;
  };

  const manifest: HelpManifest = {
    version: "1.2.3",
    available: true,
    pages: [
      { slug: "index", title: "Monize Documentation", summary: "", group: "" },
      {
        slug: "budgets",
        title: "Budgets",
        summary: "Plan spending.",
        group: "Core features",
      },
    ],
  };
  const page: HelpPage = {
    slug: "budgets",
    title: "Budgets",
    group: "Core features",
    markdown: "# Budgets\n\n## Overview\n",
    toc: [{ depth: 2, id: "overview", heading: "Overview" }],
    onlineUrl: "https://www.monize.net/docs/budgets",
    images: {},
  };
  const picture = {
    data: Buffer.from("webp bytes"),
    contentType: "image/webp",
    revision: "1.2.3-abc-def",
  };

  beforeEach(async () => {
    mockService = {
      getManifest: jest.fn().mockReturnValue(manifest),
      getPage: jest
        .fn()
        .mockImplementation((slug: string) =>
          slug === "budgets" ? page : null,
        ),
      getImage: jest
        .fn()
        .mockImplementation((name: string) =>
          Promise.resolve(name === "budgets-page.light" ? picture : null),
        ),
      search: jest.fn().mockReturnValue({
        results: [
          {
            page: "budgets",
            section: "overview",
            pageTitle: "Budgets",
            heading: "Overview",
            excerpt: "Plan spending.",
            score: 9,
          },
        ],
        total: 1,
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HelpController],
      providers: [{ provide: HelpService, useValue: mockService }],
    }).compile();
    controller = module.get(HelpController);
  });

  it("returns the manifest", () => {
    expect(controller.getManifest()).toEqual(manifest);
  });

  it("returns a page by slug", () => {
    expect(controller.getPage("budgets")).toEqual(page);
    expect(mockService.getPage).toHaveBeenCalledWith("budgets");
  });

  it("is a 404 for a slug the guide does not have", () => {
    expect(() => controller.getPage("nope")).toThrow(NotFoundException);
  });

  it.each([
    "../etc",
    "..%2Fetc",
    "%2e%2e",
    "a/b",
    "Budgets",
    "a.md",
    "",
    "a b",
  ])("is a 404 for the malformed slug %j without a lookup", (slug) => {
    expect(() => controller.getPage(slug)).toThrow(NotFoundException);
    expect(mockService.getPage).not.toHaveBeenCalled();
  });

  it("requires no authentication (public, like the release notes)", () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, HelpController),
    ).toBeUndefined();
    for (const method of [
      "getManifest",
      "getPage",
      "getImage",
      "search",
    ] as const) {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, HelpController.prototype[method]),
      ).toBeUndefined();
    }
  });
  describe("search", () => {
    it("searches with the query, context and limit", () => {
      const result = controller.search({
        q: "budgets",
        context: "dashboard",
        limit: 5,
      });

      expect(mockService.search).toHaveBeenCalledWith("budgets", {
        contextPage: "dashboard",
        limit: 5,
      });
      expect(result.results[0].page).toBe("budgets");
    });

    async function validationErrors(
      query: Record<string, unknown>,
    ): Promise<string[]> {
      const dto = plainToInstance(HelpSearchQueryDto, query);
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      return errors.map((e) => e.property);
    }

    it("accepts a bare query with no context or limit", async () => {
      expect(await validationErrors({ q: "budgets" })).toEqual([]);
    });

    it("requires a non-empty query", async () => {
      expect(await validationErrors({ q: "" })).toEqual(["q"]);
    });

    it("rejects a query over 200 characters", async () => {
      expect(await validationErrors({ q: "a".repeat(201) })).toEqual(["q"]);
    });

    it("accepts a query of exactly 200 characters", async () => {
      expect(await validationErrors({ q: "a".repeat(200) })).toEqual([]);
    });

    it("rejects a context that is not a bare page slug", async () => {
      for (const context of ["../etc", "Budgets", "a/b", "a b"]) {
        expect(await validationErrors({ q: "x", context })).toEqual([
          "context",
        ]);
      }
    });

    it("ignores rather than rejects an empty context", async () => {
      expect(await validationErrors({ q: "x", context: "" })).toEqual([]);
    });

    it.each([0, 21, -1, 1.5])("rejects limit %j", async (limit) => {
      expect(await validationErrors({ q: "x", limit })).toEqual(["limit"]);
    });

    it.each([1, 10, 20])("accepts limit %j", async (limit) => {
      expect(await validationErrors({ q: "x", limit })).toEqual([]);
    });

    it("rejects an unknown field (forbidNonWhitelisted)", async () => {
      expect(
        await validationErrors({ q: "x", extra: "nope" } as never),
      ).toEqual(["extra"]);
    });
  });

  describe("images", () => {
    function response() {
      const headers: Record<string, string> = {};
      return {
        headers,
        setHeader: jest.fn((key: string, value: string) => {
          headers[key] = value;
        }),
        send: jest.fn(),
      };
    }

    it("sends the picture with its type, cached for good at its current key", async () => {
      const res = response();

      await controller.getImage(
        "budgets-page.light",
        "1.2.3-abc-def",
        res as never,
      );

      expect(mockService.getImage).toHaveBeenCalledWith("budgets-page.light");
      expect(res.headers["Content-Type"]).toBe("image/webp");
      expect(res.headers["Cache-Control"]).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(res.send).toHaveBeenCalledWith(picture.data);
    });

    it.each([
      undefined,
      "1.2.3",
      "1.2.2-abc-def",
      "1.2.3-abc-old",
      "",
      ["1.2.3-abc-def", "x"],
    ])("revalidates every time when the key is %j", async (version) => {
      const res = response();

      await controller.getImage("budgets-page.light", version, res as never);

      expect(res.headers["Cache-Control"]).toBe(
        "public, max-age=0, must-revalidate",
      );
      expect(res.send).toHaveBeenCalledWith(picture.data);
    });

    it("is a 404 for a picture the bundle does not have", async () => {
      const res = response();

      await expect(
        controller.getImage("nope", "1.2.3", res as never),
      ).rejects.toThrow(NotFoundException);
      expect(res.send).not.toHaveBeenCalled();
    });

    it.each([
      "../nav",
      "..%2Fnav",
      "%2e%2e",
      "a/b",
      "budgets-page.webp",
      "budgets-page.png",
      "budgets-page.light.light",
      "Budgets-page",
      "",
      "a b",
    ])("is a 404 for the malformed name %j without a lookup", async (name) => {
      const res = response();

      await expect(
        controller.getImage(name, "1.2.3", res as never),
      ).rejects.toThrow(NotFoundException);
      expect(mockService.getImage).not.toHaveBeenCalled();
      expect(res.send).not.toHaveBeenCalled();
    });
  });
});
