import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
} from "@nestjs/common";
import { lastValueFrom, of, throwError } from "rxjs";
import { readMnyFixture, MNY_FIXTURES } from "./__fixtures__/mny-fixtures";
import { ImportJob } from "./entities/import-job.entity";
import { MnyImportJobService } from "./mny-import-job.service";
import { MnyImportService } from "./mny-import.service";
import {
  MNY_IMPORT_LIMIT_BYTES,
  MNY_IMPORT_LIMIT_MB,
  MnyImportController,
} from "./mny-import.controller";
import { MnyParserService } from "./mny-parser.service";
import { MnyMarketRateService } from "./mny-market-rates.service";
import { ExchangeRateService } from "../../currencies/exchange-rate.service";

/** No stored rate history and nothing from the provider. */
const noMarketRates = {
  resolveStoredRate: async () => ({ rate: null }),
  fillRateWindow: async () => ({ stored: 0, answered: true }),
};
import { MnyStagingService } from "./mny-staging.service";
import { MnyUploadErrorInterceptor } from "./mny-upload-error.interceptor";
import { DEFAULT_MNY_IMPORT_OPTIONS } from "./model/mny-import-options";

const USER = { user: { id: "user-1" } };

function uploadedFile(name: string, buffer: Buffer): Express.Multer.File {
  return {
    originalname: name,
    buffer,
    size: buffer.length,
  } as Express.Multer.File;
}

describe("MnyImportController", () => {
  let staging: Record<string, jest.Mock>;
  let jobs: Record<string, jest.Mock>;
  let importService: Record<string, jest.Mock>;
  let controller: MnyImportController;

  beforeEach(() => {
    staging = {
      stage: jest.fn().mockResolvedValue({
        id: "staged-1",
        filename: "money2008.mny",
        sourceFormat: "mny",
        sizeBytes: 1024,
        sha256: "abc",
        expiresAt: new Date(),
      }),
      remove: jest.fn().mockResolvedValue(true),
    };
    jobs = { findOne: jest.fn().mockResolvedValue(null) };
    importService = { start: jest.fn() };

    controller = new MnyImportController(
      staging as unknown as MnyStagingService,
      new MnyMarketRateService(
        new MnyParserService(),
        noMarketRates as unknown as ExchangeRateService,
      ),
      jobs as unknown as MnyImportJobService,
      importService as unknown as MnyImportService,
    );
  });

  describe("parse", () => {
    it("stages the file and returns a preview of what would be imported", async () => {
      const preview = await controller.parse(
        USER,
        uploadedFile("money2008.mny", readMnyFixture("money2008")),
        {},
      );

      expect(staging.stage).toHaveBeenCalledWith("user-1", {
        filename: "money2008.mny",
        data: expect.any(Buffer),
      });
      expect(preview).toMatchObject({
        stagedFileId: "staged-1",
        era: "moneyPlus",
        baseCurrency: "USD",
      });
      expect(preview.accounts.length).toBeGreaterThan(0);
    });

    it("echoes the server's option defaults, so the wizard need not guess them", () => {
      // ADR-5: the backend owns the defaults.
      expect(DEFAULT_MNY_IMPORT_OPTIONS.referencedOnlyPayees).toBe(true);
    });

    it("stages the decrypted bytes, so the password is spent on this request", async () => {
      await controller.parse(
        USER,
        uploadedFile("money2008-pwd.mny", readMnyFixture("money2008Pwd")),
        { password: MNY_FIXTURES.money2008Pwd.password },
      );

      const staged: Buffer = staging.stage.mock.calls[0][1].data;
      // A decrypted Jet 4 page starts with a readable page type, and the
      // ciphertext version of this file does not contain the engine string.
      expect(staged.subarray(4, 19).toString("latin1")).toContain("MSISAM");
    });

    it("rejects a file that is not a .mny", async () => {
      await expect(
        controller.parse(
          USER,
          uploadedFile("statement.qif", Buffer.from("x")),
          {},
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(staging.stage).not.toHaveBeenCalled();
    });

    it("rejects a buffer past the import limit before decrypting it", async () => {
      // multer's own limit is interceptor configuration; this is the bound the
      // handler asserts on the bytes it was actually handed.
      const oversized = {
        originalname: "huge.mny",
        buffer: { length: MNY_IMPORT_LIMIT_BYTES + 1 } as unknown as Buffer,
      } as Express.Multer.File;

      await expect(
        controller.parse(USER, oversized, {}),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(staging.stage).not.toHaveBeenCalled();
    });

    it("rejects a request with no file", async () => {
      await expect(
        controller.parse(USER, undefined as never, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("does not stage anything when the file cannot be parsed", async () => {
      await expect(
        controller.parse(
          USER,
          uploadedFile("broken.mny", Buffer.alloc(8192)),
          {},
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(staging.stage).not.toHaveBeenCalled();
    });

    describe("password taxonomy", () => {
      it("distinguishes a required password from a wrong one", async () => {
        const required = await controller
          .parse(
            USER,
            uploadedFile("pwd.mny", readMnyFixture("money2008Pwd")),
            {},
          )
          .catch((error) => error.getResponse());
        const incorrect = await controller
          .parse(
            USER,
            uploadedFile("pwd.mny", readMnyFixture("money2008Pwd")),
            {
              password: "wrong",
            },
          )
          .catch((error) => error.getResponse());

        expect(required.errorCode).toBe("mnyPasswordRequired");
        expect(incorrect.errorCode).toBe("mnyPasswordIncorrect");
      });

      it("never echoes the password in the error", async () => {
        const secret = "sup3r-s3cret-passphrase";

        const response = await controller
          .parse(
            USER,
            uploadedFile("pwd.mny", readMnyFixture("money2008Pwd")),
            {
              password: secret,
            },
          )
          .catch((error) => JSON.stringify(error.getResponse()));

        expect(response).not.toContain(secret);
      });

      it("never echoes the password in a successful preview", async () => {
        const preview = await controller.parse(
          USER,
          uploadedFile("pwd.mny", readMnyFixture("money2008Pwd")),
          { password: MNY_FIXTURES.money2008Pwd.password },
        );

        expect(JSON.stringify(preview)).not.toContain(
          MNY_FIXTURES.money2008Pwd.password as string,
        );
      });

      it("opens an unprotected file with no password at all", async () => {
        const preview = await controller.parse(
          USER,
          uploadedFile("money2008.mny", readMnyFixture("money2008")),
          {},
        );

        expect(preview.passwordProtected).toBe(false);
      });
    });
  });

  describe("start", () => {
    it("passes the staged file, options and wipe credentials through", async () => {
      importService.start.mockResolvedValue({
        id: "job-1",
        status: "pending",
        progress: null,
        result: null,
        errorKey: null,
        retryable: false,
        startedAt: null,
        completedAt: null,
      } as ImportJob);

      const job = await controller.start(USER, {
        stagedFileId: "staged-1",
        options: { wipeExistingData: true },
        wipePassword: "hunter2",
      });

      expect(importService.start).toHaveBeenCalledWith("user-1", {
        stagedFileId: "staged-1",
        options: { wipeExistingData: true },
        wipeCredentials: { password: "hunter2", oidcIdToken: undefined },
      });
      expect(job).toEqual({
        id: "job-1",
        status: "pending",
        progress: null,
        result: null,
        errorKey: null,
        retryable: false,
        startedAt: null,
        completedAt: null,
      });
    });
  });

  describe("findJob", () => {
    it("says when a failed job's rows already reached the ledger", async () => {
      // A26-H08: without the flag the wizard could only show the generic
      // failure copy, "Nothing was saved", over a committed import.
      jobs.findOne.mockResolvedValue({
        id: "job-1",
        userId: "user-1",
        sourceFormat: "mny",
        stagedFileId: "staged-1",
        status: "failed",
        progress: null,
        result: null,
        errorKey: "mnyImportFailedAfterCommit",
        errorDetail: "verify failed",
        retryable: false,
        dataCommitted: true,
        startedAt: null,
        completedAt: null,
        options: DEFAULT_MNY_IMPORT_OPTIONS,
      } as ImportJob);

      const job = await controller.findJob(USER, "job-1");

      expect(job).toMatchObject({
        status: "failed",
        errorKey: "mnyImportFailedAfterCommit",
        retryable: false,
        dataCommitted: true,
      });
    });

    it("returns only the fields the wizard needs, not the staged file id", async () => {
      jobs.findOne.mockResolvedValue({
        id: "job-1",
        userId: "user-1",
        sourceFormat: "mny",
        stagedFileId: "staged-1",
        status: "running",
        progress: { phase: "transactions", processed: 10, total: 20 },
        result: null,
        errorKey: null,
        errorDetail: null,
        retryable: false,
        startedAt: null,
        completedAt: null,
        options: DEFAULT_MNY_IMPORT_OPTIONS,
      } as ImportJob);

      const job = await controller.findJob(USER, "job-1");

      expect(job.progress).toEqual({
        phase: "transactions",
        processed: 10,
        total: 20,
      });
      expect(Object.keys(job)).not.toContain("stagedFileId");
      expect(Object.keys(job)).not.toContain("errorDetail");
    });

    it("404s for a job this user does not own", async () => {
      await expect(controller.findJob(USER, "job-1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("404s for a KMyMoney job, as the KMyMoney route does for a Money job", async () => {
      jobs.findOne.mockResolvedValue({
        id: "job-1",
        userId: "user-1",
        sourceFormat: "kmy",
      } as ImportJob);

      await expect(controller.findJob(USER, "job-1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("discard", () => {
    it("removes the staged file", async () => {
      await expect(
        controller.discard(USER, "staged-1"),
      ).resolves.toBeUndefined();
      expect(staging.remove).toHaveBeenCalledWith("user-1", "staged-1", "mny");
    });

    it("asks the staging service to discard only a Money file, so a KMyMoney file is a 404", async () => {
      staging.remove.mockResolvedValue(false);

      await expect(controller.discard(USER, "kmy-file")).rejects.toThrow(
        /Money file is no longer available/,
      );
      expect(staging.remove).toHaveBeenCalledWith("user-1", "kmy-file", "mny");
    });

    it("404s when there was nothing to discard", async () => {
      staging.remove.mockResolvedValue(false);

      await expect(controller.discard(USER, "staged-1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("upload limit", () => {
    it("derives the byte limit from MNY_IMPORT_LIMIT_MB", () => {
      expect(MNY_IMPORT_LIMIT_BYTES).toBe(MNY_IMPORT_LIMIT_MB * 1024 * 1024);
      expect(MNY_IMPORT_LIMIT_MB).toBeGreaterThan(0);
    });

    it("turns multer's size error into a localized message naming the limit", async () => {
      const interceptor = new MnyUploadErrorInterceptor(300);
      const next = {
        handle: () =>
          throwError(() => new PayloadTooLargeException("File too large")),
      };

      const response = (await lastValueFrom(
        interceptor.intercept({} as never, next as never),
      ).catch((error) => error.getResponse())) as {
        errorCode: string;
        message: string;
      };

      expect(response.errorCode).toBe("mnyFileTooLarge");
      expect(response.message).toContain("300");
      expect(response.message).not.toBe("File too large");
    });

    it("leaves any other error untouched", async () => {
      const interceptor = new MnyUploadErrorInterceptor(300);
      const original = new BadRequestException("something else");
      const next = { handle: () => throwError(() => original) };

      await expect(
        lastValueFrom(interceptor.intercept({} as never, next as never)),
      ).rejects.toBe(original);
    });

    it("passes a successful response through", async () => {
      const interceptor = new MnyUploadErrorInterceptor(300);
      const next = { handle: () => of("preview") };

      await expect(
        lastValueFrom(interceptor.intercept({} as never, next as never)),
      ).resolves.toBe("preview");
    });
  });
});
