import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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

import {
  AllowDelegate,
  DelegateRequiresSection,
} from "../delegation/decorators/delegate-access.decorator";
import { delegateReadableAccountScope } from "../delegation/delegate-account-scope.util";
import { DelegationService } from "../delegation/delegation.service";
import { tr } from "../i18n/translate";
import { CreateWarrantyDto } from "./dto/create-warranty.dto";
import { ImportWarrantiesDto } from "./dto/import-warranties.dto";
import { ListWarrantiesDto } from "./dto/list-warranties.dto";
import { UpdateWarrantyDto } from "./dto/update-warranty.dto";
import {
  WarrantyListResult,
  WarrantySummary,
  WarrantyView,
} from "./dto/warranty-response.dto";
import { WarrantiesService } from "./warranties.service";
import {
  WARRANTY_IMPORT_MAX_BYTES,
  WarrantyImportResult,
  WarrantyImportService,
} from "./warranty-import.service";
import { AllowPat } from "../auth/pat-access/pat-access.decorator";

/**
 * The content types a browser sends for a `.csv` file: `text/csv` and its
 * older spellings, plain text, Excel's registration on Windows, and
 * `application/octet-stream`, which a browser sends for an extension the
 * operating system has no type for (a `.csv` on a machine without a
 * spreadsheet app). A CSV has no magic bytes to sniff, so the type is only a
 * first filter; the size limit bounds the read and the parser refuses what is
 * not a table.
 */
const CSV_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text/csv",
  "text/x-csv",
  "text/comma-separated-values",
  "application/csv",
  "text/plain",
  "application/vnd.ms-excel",
  "application/octet-stream",
]);

/**
 * A user's warranties (docs/specs/warranty-tracker.md section 6.5).
 *
 * The read routes carry `@AllowDelegate()` with
 * `@DelegateRequiresSection("warranties")` (design decision 9): a delegate the
 * owner granted the section sees every warranty, and the service narrows each
 * row's linked purchase to the accounts the delegation grants READ on, which
 * `delegateReadableAccountScope` resolves once per request here (WTY-007).
 * Every write stays owner-only by the global `AccountDelegateGuard`'s default.
 *
 * `userId` comes from the JWT on every route and is never read from the request.
 */
@ApiTags("Warranties")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@AllowPat()
@Controller("warranties")
export class WarrantiesController {
  constructor(
    private readonly warrantiesService: WarrantiesService,
    private readonly delegationService: DelegationService,
    private readonly warrantyImportService: WarrantyImportService,
  ) {}

  @Get()
  @AllowDelegate()
  @DelegateRequiresSection("warranties")
  @ApiOperation({ summary: "List the caller's warranties" })
  @ApiResponse({ status: 200, description: "One page of warranties" })
  async findAll(
    @Request() req,
    @Query() query: ListWarrantiesDto,
  ): Promise<WarrantyListResult> {
    const accountScope = await delegateReadableAccountScope(
      req,
      this.delegationService,
    );
    return this.warrantiesService.findAll(req.user.id, query, { accountScope });
  }

  // Declared before `:id`, which would otherwise take "summary" as an id.
  @Get("summary")
  @AllowDelegate()
  @DelegateRequiresSection("warranties")
  @ApiOperation({ summary: "Unarchived warranties counted per status" })
  @ApiResponse({ status: 200, description: "Counts per status" })
  summary(@Request() req): Promise<WarrantySummary> {
    return this.warrantiesService.summary(req.user.id);
  }

  // Declared before the `:id` routes. Owner-only: no `@AllowDelegate()`.
  @Post("import")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Preview (dryRun, the default) or import a Warracker-format CSV of warranties",
  })
  @ApiConsumes("multipart/form-data")
  @ApiResponse({ status: 200, description: "One verdict per data row" })
  @ApiResponse({
    status: 400,
    description: "Not a CSV, missing columns, too many rows or invalid rows",
  })
  @ApiResponse({ status: 413, description: "The file is larger than 1 MiB" })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: WARRANTY_IMPORT_MAX_BYTES, files: 1 },
    }),
  )
  importCsv(
    @Request() req,
    @Query() query: ImportWarrantiesDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<WarrantyImportResult> {
    if (!file) {
      throw new BadRequestException(
        tr("errors.warranties.import.noFile", "Choose a CSV file to import"),
      );
    }
    const contentType = (file.mimetype ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!CSV_CONTENT_TYPES.has(contentType)) {
      throw new BadRequestException(
        tr("errors.warranties.import.notCsv", "The file must be a CSV file"),
      );
    }
    return this.warrantyImportService.run(
      req.user.id,
      file.buffer.toString("utf8"),
      { dryRun: query.dryRun ?? true, skipInvalid: query.skipInvalid ?? false },
    );
  }

  @Get(":id")
  @AllowDelegate()
  @DelegateRequiresSection("warranties")
  @ApiOperation({ summary: "Get one warranty" })
  @ApiResponse({ status: 200, description: "The warranty" })
  @ApiResponse({ status: 404, description: "Warranty not found" })
  async findOne(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<WarrantyView> {
    const accountScope = await delegateReadableAccountScope(
      req,
      this.delegationService,
    );
    return this.warrantiesService.findOne(req.user.id, id, { accountScope });
  }

  @Post()
  @ApiOperation({ summary: "Create a warranty" })
  @ApiResponse({ status: 201, description: "The created warranty" })
  @ApiResponse({ status: 400, description: "Invalid expiry, price or term" })
  @ApiResponse({
    status: 404,
    description: "Linked transaction, payee or currency not found",
  })
  create(
    @Request() req,
    @Body() dto: CreateWarrantyDto,
  ): Promise<WarrantyView> {
    return this.warrantiesService.create(req.user.id, dto);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a warranty" })
  @ApiResponse({ status: 200, description: "The updated warranty" })
  @ApiResponse({ status: 400, description: "Invalid expiry, price or term" })
  @ApiResponse({
    status: 404,
    description: "Warranty, linked transaction, payee or currency not found",
  })
  update(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateWarrantyDto,
  ): Promise<WarrantyView> {
    return this.warrantiesService.update(req.user.id, id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete a warranty, its claims and its documents" })
  @ApiResponse({ status: 204, description: "Deleted" })
  @ApiResponse({ status: 404, description: "Warranty not found" })
  async remove(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.warrantiesService.remove(req.user.id, id);
  }

  @Post(":id/archive")
  @HttpCode(200)
  @ApiOperation({ summary: "Archive a warranty, keeping its history" })
  @ApiResponse({ status: 200, description: "The archived warranty" })
  @ApiResponse({ status: 404, description: "Warranty not found" })
  archive(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<WarrantyView> {
    return this.warrantiesService.archive(req.user.id, id);
  }

  @Post(":id/unarchive")
  @HttpCode(200)
  @ApiOperation({ summary: "Return an archived warranty to the list" })
  @ApiResponse({ status: 200, description: "The unarchived warranty" })
  @ApiResponse({ status: 404, description: "Warranty not found" })
  unarchive(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<WarrantyView> {
    return this.warrantiesService.unarchive(req.user.id, id);
  }
}
