import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
} from "@nestjs/common";
import { lastValueFrom, throwError } from "rxjs";
import { ALLOW_PAT_KEY } from "../../auth/pat-access/pat-access.decorator";
import { ImportJob } from "../mny/entities/import-job.entity";
import { MnyImportJobService } from "../mny/mny-import-job.service";
import { MnyImportService } from "../mny/mny-import.service";
import { MnyStagingService } from "../mny/mny-staging.service";
import { MNY_IMPORT_LIMIT_BYTES } from "../mny/mny-import.controller";
import { MnyUploadErrorInterceptor } from "../mny/mny-upload-error.interceptor";
import { readKmyFixture } from "./__fixtures__/kmy-fixtures";
import { KmyImportController } from "./kmy-import.controller";
import { KmyParserService } from "./kmy-parser.service";
import { parseKmyBytes } from "./kmy-parse";
import { kmyFileTooLargeException } from "./kmy-upload-error";
import {
  KmyAnonymizedFileError,
  KmyEncryptedFileError,
  KmyMappingFailedError,
  KmyXmlTooLargeError,
} from "./model/kmy-errors";
import { MnyImportError } from "../mny/mny-errors";

const USER = { user: { id: "user-1" } };

function uploadedFile(name: string, buffer: Buffer): Express.Multer.File {
  return {
    originalname: name,
    buffer,
    size: buffer.length,
  } as Express.Multer.File;
}

describe("KmyImportController", () => {
  let staging: Record<string, jest.Mock>;
  let jobs: Record<string, jest.Mock>;
  let importService: Record<string, jest.Mock>;
  let parser: { parse: jest.Mock };
  let controller: KmyImportController;
  const realParser = new KmyParserService({} as never);

  beforeEach(() => {
    staging = {
      stage: jest.fn().mockResolvedValue({
        id: "staged-1",
        filename: "books.kmy",
        sourceFormat: "kmy",
        sizeBytes: 1024,
      }),
      findInfo: jest.fn().mockResolvedValue({ id: "s", sourceFormat: "kmy" }),
      remove: jest.fn().mockResolvedValue(true),
    };
    jobs = { findOne: jest.fn().mockResolvedValue(null) };
    importService = { start: jest.fn() };
    parser = { parse: jest.fn() };
    // Delegate to the real mapper, with the database read stubbed out.
    parser.parse.mockImplementation(async (input) => {
      return parseKmyBytes({
        bytes: input.buffer,
        filename: input.filename,
        maxXmlBytes: MNY_IMPORT_LIMIT_BYTES,
        userDefaultCurrency: "USD",
        phoneRegion: null,
        coinDecimals: new Map(),
        asOf: "2026-01-01",
      });
    });
    controller = new KmyImportController(
      staging as unknown as MnyStagingService,
      parser as unknown as KmyParserService,
      jobs as unknown as MnyImportJobService,
      importService as unknown as MnyImportService,
    );
  });

  describe("parse", () => {
    it("stages the file as kmy and returns a kmy preview", async () => {
      const preview = await controller.parse(
        USER,
        uploadedFile("books.kmy", readKmyFixture("syntheticKmy")),
      );
      expect(staging.stage).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({ filename: "books.kmy", sourceFormat: "kmy" }),
      );
      expect(preview.sourceFormat).toBe("kmy");
      expect(preview.stagedFileId).toBe("staged-1");
      expect(preview.kmyFile?.container).toBe("gzip");
    });

    it("accepts any extension; the container decides", async () => {
      await expect(
        controller.parse(
          USER,
          uploadedFile("books.data", readKmyFixture("syntheticXml")),
        ),
      ).resolves.toBeDefined();
    });

    it.each([undefined, uploadedFile("a.kmy", Buffer.alloc(0))])(
      "answers kmyNoFile for a missing or empty part",
      async (file) => {
        const error = await controller
          .parse(USER, file as Express.Multer.File)
          .catch((e) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.getResponse().errorCode).toBe("kmyNoFile");
      },
    );

    it("rejects a buffer past the limit before parsing", async () => {
      const big = {
        originalname: "a.kmy",
        buffer: { length: MNY_IMPORT_LIMIT_BYTES + 1 },
      };
      const error = await controller
        .parse(USER, big as unknown as Express.Multer.File)
        .catch((e) => e);
      expect(error).toBeInstanceOf(PayloadTooLargeException);
      expect(error.getResponse().errorCode).toBe("kmyFileTooLarge");
      expect(parser.parse).not.toHaveBeenCalled();
    });

    it.each([
      [new KmyEncryptedFileError(), "kmyEncryptedFile"],
      [new KmyAnonymizedFileError(), "kmyAnonymizedFile"],
      [new KmyXmlTooLargeError(300), "kmyXmlTooLarge"],
    ])(
      "maps %s to a 400 with its code and stages nothing",
      async (refusal, code) => {
        parser.parse.mockRejectedValue(refusal);
        const error = await controller
          .parse(USER, uploadedFile("a.kmy", Buffer.from("x")))
          .catch((e) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.getResponse().errorCode).toBe(code);
        expect(staging.stage).not.toHaveBeenCalled();
      },
    );

    it("names the inflated-document bound, not the upload limit, in the too-large message", async () => {
      parser.parse.mockRejectedValue(new KmyXmlTooLargeError(100));
      const error = await controller
        .parse(USER, uploadedFile("a.kmy", Buffer.from("x")))
        .catch((e) => e);
      expect(error.getResponse().message).toContain("100 MB");
    });

    it("maps a mapper failure to a translated 500 with its own code, staging nothing (MIN-2)", async () => {
      parser.parse.mockRejectedValue(
        new KmyMappingFailedError(new TypeError("defect")),
      );
      const error = await controller
        .parse(USER, uploadedFile("a.kmy", Buffer.from("x")))
        .catch((e) => e);
      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect(error.getResponse()).toMatchObject({
        errorCode: "kmyMappingFailed",
        message: expect.stringContaining("fault in Monize"),
      });
      expect(staging.stage).not.toHaveBeenCalled();
    });

    it("lets an untyped or non-kmy error propagate", async () => {
      parser.parse.mockRejectedValue(new TypeError("defect"));
      await expect(
        controller.parse(USER, uploadedFile("a.kmy", Buffer.from("x"))),
      ).rejects.toThrow(TypeError);
      parser.parse.mockRejectedValue(
        new MnyImportError("mnyNotAMoneyFile", "money code"),
      );
      await expect(
        controller.parse(USER, uploadedFile("a.kmy", Buffer.from("x"))),
      ).rejects.toBeInstanceOf(MnyImportError);
    });

    it("never passes a password: the parse call carries user, bytes and name only", async () => {
      await controller.parse(
        USER,
        uploadedFile("books.kmy", readKmyFixture("syntheticKmy")),
      );
      expect(Object.keys(parser.parse.mock.calls[0][0]).sort()).toEqual([
        "buffer",
        "filename",
        "userId",
      ]);
    });
  });

  describe("start", () => {
    it("starts a kmy import with the wipe credentials", async () => {
      importService.start.mockResolvedValue({
        id: "job-1",
        status: "pending",
        progress: null,
        result: null,
        errorKey: null,
        retryable: false,
        dataCommitted: false,
        startedAt: null,
        completedAt: null,
      });
      const dto = await controller.start(USER, {
        stagedFileId: "00000000-0000-4000-8000-000000000001",
        options: { wipeExistingData: true },
        wipePassword: "pw",
      } as never);
      expect(importService.start).toHaveBeenCalledWith("user-1", {
        stagedFileId: "00000000-0000-4000-8000-000000000001",
        options: { wipeExistingData: true },
        wipeCredentials: { password: "pw", oidcIdToken: undefined },
        sourceFormat: "kmy",
      });
      expect(dto.id).toBe("job-1");
      expect(dto).not.toHaveProperty("stagedFileId");
    });
  });

  describe("findJob", () => {
    it("returns a kmy job", async () => {
      jobs.findOne.mockResolvedValue({
        id: "job-1",
        sourceFormat: "kmy",
        status: "completed",
      } as ImportJob);
      await expect(controller.findJob(USER, "job-1")).resolves.toMatchObject({
        id: "job-1",
      });
    });

    it.each([null, { id: "job-1", sourceFormat: "mny" }])(
      "404s for a missing job or a Money job",
      async (job) => {
        jobs.findOne.mockResolvedValue(job);
        await expect(controller.findJob(USER, "job-1")).rejects.toBeInstanceOf(
          NotFoundException,
        );
      },
    );
  });

  describe("discard", () => {
    it("removes a kmy staged file", async () => {
      await controller.discard(USER, "staged-1");
      expect(staging.remove).toHaveBeenCalledWith("user-1", "staged-1", "kmy");
    });

    it("404s with the KMyMoney message for a Money staged file, which the staging service refuses to remove", async () => {
      staging.remove.mockResolvedValue(false);
      await expect(controller.discard(USER, "s")).rejects.toThrow(
        /KMyMoney file is no longer available/,
      );
      expect(staging.remove).toHaveBeenCalledWith("user-1", "s", "kmy");
    });

    it("404s when the row vanished before removal", async () => {
      staging.remove.mockResolvedValue(false);
      await expect(controller.discard(USER, "s")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("decorators", () => {
    const flag = (name: keyof KmyImportController) =>
      Reflect.getMetadata(ALLOW_PAT_KEY, KmyImportController.prototype[name]);

    it("allows PATs on the class and refuses them on start", () => {
      expect(Reflect.getMetadata(ALLOW_PAT_KEY, KmyImportController)).toBe(
        true,
      );
      expect(flag("start")).toBe(false);
      expect(flag("parse")).toBeUndefined();
    });

    it("localizes multer's size error as a KMyMoney message", async () => {
      const interceptor = new MnyUploadErrorInterceptor(
        300,
        kmyFileTooLargeException,
      );
      const next = {
        handle: () =>
          throwError(() => new PayloadTooLargeException("File too large")),
      };
      const response = (await lastValueFrom(
        interceptor.intercept({} as never, next as never),
      ).catch((e) => e.getResponse())) as {
        errorCode: string;
        message: string;
      };
      expect(response.errorCode).toBe("kmyFileTooLarge");
      expect(response.message).toContain("KMyMoney");
    });
  });

  it("is constructed with a real parser type", () => {
    expect(realParser.sourceFormat).toBe("kmy");
  });
});
