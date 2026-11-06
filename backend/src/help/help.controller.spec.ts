import { NotFoundException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Test, TestingModule } from "@nestjs/testing";
import { HelpController } from "./help.controller";
import { HelpService } from "./help.service";
import { HelpManifest, HelpPage } from "./dto/help-response.dto";

describe("HelpController", () => {
  let controller: HelpController;
  let mockService: { getManifest: jest.Mock; getPage: jest.Mock };

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
  };

  beforeEach(async () => {
    mockService = {
      getManifest: jest.fn().mockReturnValue(manifest),
      getPage: jest
        .fn()
        .mockImplementation((slug: string) =>
          slug === "budgets" ? page : null,
        ),
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
    for (const method of ["getManifest", "getPage"] as const) {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, HelpController.prototype[method]),
      ).toBeUndefined();
    }
  });
});
