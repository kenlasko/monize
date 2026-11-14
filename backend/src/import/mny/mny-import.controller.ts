import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Body,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { tr } from "../../i18n/translate";
import { ImportJob } from "./entities/import-job.entity";
import { MnyImportError } from "./mny-errors";
import { MnyImportJobService } from "./mny-import-job.service";
import { MnyImportService } from "./mny-import.service";
import { MnyMarketRateService } from "./mny-market-rates.service";
import { MnyStagingService } from "./mny-staging.service";
import { MnyPreview, buildPreview } from "./mny-preview";
import {
  MnyUploadErrorInterceptor,
  mnyFileTooLargeException,
} from "./mny-upload-error.interceptor";
import {
  MnyImportJobDto,
  ParseMnyDto,
  StartMnyImportDto,
} from "./dto/mny-import.dto";
import { MnyImportOptions } from "./model/mny-import-options";
import { AllowPat, NoPat } from "../../auth/pat-access/pat-access.decorator";

/**
 * The four calls the wizard makes for a Microsoft Money import.
 *
 * Transport is multipart (design ADR-1), like attachments: a `.mny` file is
 * binary and 200 MB-class, so it cannot go through the JSON body the QIF/OFX/CSV
 * endpoints use. The limit comes from `MNY_IMPORT_LIMIT_MB` and is enforced by
 * multer before a byte reaches the service.
 *
 * Every parse failure is reported as a stable code the frontend localizes. The
 * one distinction that matters most for usability is "this file needs a password"
 * versus "that password is wrong" -- without it, a user with a protected file
 * cannot tell whether to type a password or a different one.
 */

/** Upload ceiling. Read once at module load, as the interceptor is a decorator. */
export const MNY_IMPORT_LIMIT_MB =
  Number(process.env.MNY_IMPORT_LIMIT_MB) || 300;
export const MNY_IMPORT_LIMIT_BYTES = MNY_IMPORT_LIMIT_MB * 1024 * 1024;

/** Extensions the wizard accepts. `.mbf` backup archives are a documented non-goal. */
const MNY_EXTENSION = /\.mny$/i;

function toJobDto(job: ImportJob): MnyImportJobDto {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    result: job.result,
    errorKey: job.errorKey,
    retryable: job.retryable,
    dataCommitted: job.dataCommitted,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

@ApiTags("Import")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@AllowPat()
@Controller("import/mny")
export class MnyImportController {
  constructor(
    private readonly staging: MnyStagingService,
    private readonly parser: MnyMarketRateService,
    private readonly jobs: MnyImportJobService,
    private readonly importService: MnyImportService,
  ) {}

  @Post("parse")
  @ApiOperation({
    summary:
      "Decrypt and preview a Microsoft Money file, staging it for import",
  })
  @ApiConsumes("multipart/form-data")
  @ApiResponse({
    status: 201,
    description: "Preview of what would be imported",
  })
  @ApiResponse({ status: 400, description: "Not a readable Money file" })
  @ApiResponse({ status: 413, description: "File exceeds MNY_IMPORT_LIMIT_MB" })
  @UseInterceptors(
    // Outside the FileInterceptor, so multer's untranslated size error is
    // localized before it reaches the client.
    new MnyUploadErrorInterceptor(MNY_IMPORT_LIMIT_MB),
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: MNY_IMPORT_LIMIT_BYTES, files: 1 },
    }),
  )
  async parse(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: ParseMnyDto,
  ): Promise<MnyPreview> {
    if (!file?.buffer?.length) {
      throw new BadRequestException(
        tr("errors.import.mnyNoFile", "No Money file was uploaded"),
      );
    }
    if (!MNY_EXTENSION.test(file.originalname)) {
      throw new BadRequestException(
        tr(
          "errors.import.mnyNotAMoneyFile",
          "That file is not a Microsoft Money (.mny) file",
        ),
      );
    }

    // multer already refuses an over-limit upload, but the bound is re-asserted
    // on the buffer that actually arrived. It is the only place the size of the
    // bytes entering the decryptor is checked in code rather than in interceptor
    // configuration -- which is also what makes the page loop in `rc4InPlace`
    // provably finite (CodeQL js/loop-bound-injection).
    const bytes = file.buffer;
    if (bytes.length > MNY_IMPORT_LIMIT_BYTES) {
      throw mnyFileTooLargeException(MNY_IMPORT_LIMIT_MB);
    }

    // Parse first, stage second: an unreadable file, or one whose password is
    // wrong, must not leave bytes behind. The buffer is decrypted in place, so
    // what gets staged is already plaintext and the password is spent here.
    const parsed = await this.parseOrTranslate(bytes, dto.password);
    const staged = await this.staging.stage(req.user.id, {
      filename: file.originalname,
      data: bytes,
    });

    return buildPreview({
      parsed,
      stagedFileId: staged.id,
      filename: staged.filename,
      sizeBytes: staged.sizeBytes,
    });
  }

  @Post("start")
  @NoPat()
  @ApiOperation({
    summary: "Start importing a staged Money file in the background",
  })
  @ApiResponse({
    status: 201,
    description: "The job to poll",
    type: MnyImportJobDto,
  })
  @ApiResponse({ status: 404, description: "Staged file expired or not found" })
  @ApiResponse({ status: 409, description: "An import is already running" })
  async start(
    @Request() req,
    @Body() dto: StartMnyImportDto,
  ): Promise<MnyImportJobDto> {
    const job = await this.importService.start(req.user.id, {
      stagedFileId: dto.stagedFileId,
      options: dto.options as Partial<MnyImportOptions> | undefined,
      wipeCredentials: {
        password: dto.wipePassword,
        oidcIdToken: dto.wipeOidcIdToken,
      },
    });
    return toJobDto(job);
  }

  @Get("jobs/:id")
  @ApiOperation({ summary: "Poll an import job" })
  @ApiResponse({ status: 200, type: MnyImportJobDto })
  @ApiResponse({ status: 404, description: "No such job for this user" })
  async findJob(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<MnyImportJobDto> {
    const job = await this.jobs.findOne(req.user.id, id);
    if (!job) {
      throw new NotFoundException(
        tr("errors.import.mnyJobNotFound", "Import job not found"),
      );
    }
    return toJobDto(job);
  }

  @Delete("staged/:id")
  @HttpCode(204)
  @ApiOperation({
    summary: "Discard a staged Money file without importing it",
  })
  @ApiResponse({ status: 204, description: "Staged file discarded" })
  @ApiResponse({
    status: 404,
    description: "No such staged file for this user",
  })
  @ApiResponse({
    status: 409,
    description: "A pending or running import still needs the file",
  })
  async discard(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    const removed = await this.staging.remove(req.user.id, id);
    if (!removed) {
      throw new NotFoundException(
        tr(
          "errors.import.mnyStagedFileMissing",
          "The uploaded Money file is no longer available. Please upload it again.",
        ),
      );
    }
  }

  /**
   * Turns a parse failure into a localized 400 carrying the stable code, so the
   * wizard can react (prompt for a password, offer the Sunset-conversion note)
   * rather than only showing text.
   *
   * The password is never part of a message here, and the underlying error's
   * message never contains it either -- see `mny-errors.ts`.
   */
  private async parseOrTranslate(buffer: Buffer, password?: string) {
    try {
      return await this.parser.parse({
        buffer,
        password,
        // Only used when the file names no base currency of its own; the import
        // itself re-reads the user's real preference.
        userDefaultCurrency: "USD",
      });
    } catch (error) {
      if (error instanceof MnyImportError) {
        throw new BadRequestException({
          message: MNY_ERROR_MESSAGES[error.code](),
          errorCode: error.code,
        });
      }
      throw error;
    }
  }
}

/**
 * One localized message per parse failure code. Kept beside the controller
 * because the frontend also branches on `errorCode`: the message is what a user
 * reads, the code is what the wizard acts on.
 */
const MNY_ERROR_MESSAGES: Record<string, () => string> = {
  mnyFileTruncated: () =>
    tr(
      "errors.import.mnyFileTruncated",
      "That Money file looks incomplete. The upload may have been interrupted -- try again.",
    ),
  mnyNotAMoneyFile: () =>
    tr(
      "errors.import.mnyNotAMoneyFile",
      "That file is not a Microsoft Money (.mny) file",
    ),
  mnyUnsupportedVersion: () =>
    tr(
      "errors.import.mnyUnsupportedVersion",
      "That file was written by Money 97 or 98, which Monize cannot read. Open and save it once in the free Money Plus Sunset edition, then import the result.",
    ),
  mnyPasswordRequired: () =>
    tr(
      "errors.import.mnyPasswordRequired",
      "That Money file is password protected. Enter its password to continue.",
    ),
  mnyPasswordIncorrect: () =>
    tr(
      "errors.import.mnyPasswordIncorrect",
      "That password does not open the Money file. Check it and try again.",
    ),
  mnyUnreadableDatabase: () =>
    tr(
      "errors.import.mnyUnreadableDatabase",
      "That Money file was decrypted but its contents could not be read. It may be damaged.",
    ),
  mnyStagedFileMissing: () =>
    tr(
      "errors.import.mnyStagedFileMissing",
      "The uploaded Money file is no longer available. Please upload it again.",
    ),
};
