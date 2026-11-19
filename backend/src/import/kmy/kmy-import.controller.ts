import {
  BadRequestException,
  InternalServerErrorException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
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
import { AllowPat, NoPat } from "../../auth/pat-access/pat-access.decorator";
import { MnyImportError } from "../mny/mny-errors";
import { MnyImportJobService } from "../mny/mny-import-job.service";
import { MnyImportService } from "../mny/mny-import.service";
import { MnyStagingService } from "../mny/mny-staging.service";
import { MnyPreview, buildPreview } from "../mny/mny-preview";
import { MnyUploadErrorInterceptor } from "../mny/mny-upload-error.interceptor";
import {
  MNY_IMPORT_LIMIT_BYTES,
  MNY_IMPORT_LIMIT_MB,
  toJobDto,
} from "../mny/mny-import.controller";
import { MnyImportJobDto, StartMnyImportDto } from "../mny/dto/mny-import.dto";
import { MnyImportOptions } from "../mny/model/mny-import-options";
import {
  KMY_ERROR_MESSAGES,
  kmyFileTooLargeException,
} from "./kmy-upload-error";
import { KmyParserService } from "./kmy-parser.service";
import { limitMb } from "./reader/kmy-container";
import { KMY_MAX_XML_BYTES } from "./reader/kmy-limits";
import type { KmyErrorCode } from "./model/kmy-errors";

function stagedFileMissing(): NotFoundException {
  return new NotFoundException(
    tr(
      "errors.import.kmyStagedFileMissing",
      "The uploaded KMyMoney file is no longer available. Please upload it again.",
    ),
  );
}

/**
 * The four calls the wizard makes for a KMyMoney import, mirroring
 * `MnyImportController` (multipart upload, memory storage, the shared limit).
 * A KMyMoney file has no password and no extension check: the container is
 * detected from its bytes (spec 4.3). Job and staged-file ids belonging to a
 * Money import are refused as if they did not exist.
 */
@ApiTags("Import")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@AllowPat()
@Controller("import/kmy")
export class KmyImportController {
  constructor(
    private readonly staging: MnyStagingService,
    private readonly parser: KmyParserService,
    private readonly jobs: MnyImportJobService,
    private readonly importService: MnyImportService,
  ) {}

  @Post("parse")
  @ApiOperation({
    summary: "Read and preview a KMyMoney file, staging it for import",
  })
  @ApiConsumes("multipart/form-data")
  @ApiResponse({
    status: 201,
    description: "Preview of what would be imported",
  })
  @ApiResponse({ status: 400, description: "Not a readable KMyMoney file" })
  @ApiResponse({ status: 413, description: "File exceeds MNY_IMPORT_LIMIT_MB" })
  @UseInterceptors(
    new MnyUploadErrorInterceptor(
      MNY_IMPORT_LIMIT_MB,
      kmyFileTooLargeException,
    ),
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: MNY_IMPORT_LIMIT_BYTES, files: 1 },
    }),
  )
  async parse(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<MnyPreview> {
    if (!file?.buffer?.length) {
      throw new BadRequestException({
        message: tr(
          "errors.import.kmyNoFile",
          "No KMyMoney file was uploaded.",
        ),
        errorCode: "kmyNoFile",
      });
    }
    // multer already refuses an over-limit upload; the bound is re-asserted on
    // the buffer that actually arrived.
    const bytes = file.buffer;
    if (bytes.length > MNY_IMPORT_LIMIT_BYTES) {
      throw kmyFileTooLargeException(MNY_IMPORT_LIMIT_MB);
    }

    // Parse first, stage second: an unreadable file must not leave bytes behind.
    const parsed = await this.parseOrTranslate(
      req.user.id,
      bytes,
      file.originalname,
    );
    const staged = await this.staging.stage(req.user.id, {
      filename: file.originalname,
      data: bytes,
      sourceFormat: "kmy",
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
    summary: "Start importing a staged KMyMoney file in the background",
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
      sourceFormat: "kmy",
    });
    return toJobDto(job);
  }

  @Get("jobs/:id")
  @ApiOperation({ summary: "Poll a KMyMoney import job" })
  @ApiResponse({ status: 200, type: MnyImportJobDto })
  @ApiResponse({ status: 404, description: "No such job for this user" })
  async findJob(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<MnyImportJobDto> {
    const job = await this.jobs.findOne(req.user.id, id);
    if (!job || job.sourceFormat !== "kmy") {
      throw new NotFoundException(
        tr("errors.import.mnyJobNotFound", "Import job not found"),
      );
    }
    return toJobDto(job);
  }

  @Delete("staged/:id")
  @HttpCode(204)
  @ApiOperation({
    summary: "Discard a staged KMyMoney file without importing it",
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
    const removed = await this.staging.remove(req.user.id, id, "kmy");
    if (!removed) {
      throw stagedFileMissing();
    }
  }

  /** A refusal becomes a localized 400 carrying the stable code. */
  private async parseOrTranslate(
    userId: string,
    buffer: Buffer,
    filename: string,
  ) {
    try {
      return await this.parser.parse({ userId, buffer, filename });
    } catch (error) {
      if (error instanceof MnyImportError && error.code in KMY_ERROR_MESSAGES) {
        const code = error.code as KmyErrorCode;
        const body = {
          message: KMY_ERROR_MESSAGES[code](limitMb(KMY_MAX_XML_BYTES)),
          errorCode: code,
        };
        // A mapper failure is the server's defect, not a bad request.
        throw code === "kmyMappingFailed"
          ? new InternalServerErrorException(body)
          : new BadRequestException(body);
      }
      throw error;
    }
  }
}
