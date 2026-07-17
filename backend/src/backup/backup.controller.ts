import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  UseGuards,
  Request,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { Response } from "express";
import { BackupService } from "./backup.service";
import { AutoBackupService } from "./auto-backup.service";
import { BackupEncryptionService } from "./backup-encryption.service";
import { SupportBackupService } from "./support-backup/support-backup.service";
import { CreateSupportBackupDto } from "./support-backup/dto/create-support-backup.dto";
import {
  UpdateAutoBackupSettingsDto,
  ValidateFolderDto,
} from "./dto/update-auto-backup-settings.dto";
import {
  EnableLocalEncryptionDto,
  SetBackupPasswordDto,
} from "./dto/backup-encryption.dto";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { tr } from "../i18n/translate";

// Password header values are base64-encoded by the client so leading/trailing
// whitespace (and non-ASCII characters) survive HTTP header transport, which
// otherwise strips surrounding whitespace per RFC 7230. Decode them back to the
// exact password the user typed before any credential comparison or decryption.
function decodePasswordHeader(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Buffer.from(value, "base64").toString("utf8");
}

@ApiTags("Backup")
@Controller("backup")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class BackupController {
  constructor(
    private readonly backupService: BackupService,
    private readonly autoBackupService: AutoBackupService,
    private readonly backupEncryption: BackupEncryptionService,
    private readonly supportBackupService: SupportBackupService,
  ) {}

  @Post("export")
  @DemoRestricted()
  @ApiOperation({ summary: "Export all user data as JSON backup" })
  @ApiResponse({ status: 200, description: "Backup file downloaded" })
  async exportBackup(@Request() req, @Res() res: Response) {
    // Encryption password (when encryption is enabled) comes via header so the
    // browser can issue a plain GET-like POST without a body parser dependency
    // and so it never lands in server access logs as a query string.
    const encryptionPassword = decodePasswordHeader(
      req.headers["x-export-password"] as string | undefined,
    );

    const today = new Date().toISOString().slice(0, 10);
    const filename = encryptionPassword
      ? `monize-backup-${today}.mzbe`
      : `monize-backup-${today}.json.gz`;
    const contentType = encryptionPassword
      ? "application/octet-stream"
      : "application/gzip";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await this.backupService.streamExport(req.user.id, res, encryptionPassword);
  }

  @Post("support-export")
  @DemoRestricted()
  @ApiOperation({
    summary:
      "Export a de-identified backup for sharing with support (masked text, scaled amounts)",
  })
  @ApiResponse({ status: 200, description: "De-identified backup downloaded" })
  async supportExport(
    @Request() req,
    @Body() dto: CreateSupportBackupDto,
    @Res() res: Response,
  ) {
    const { buffer, encrypted } = await this.supportBackupService.generate(
      req.user.id,
      dto,
    );
    const today = new Date().toISOString().slice(0, 10);
    const filename = encrypted
      ? `monize-support-backup-${today}.mzbe`
      : `monize-support-backup-${today}.json.gz`;
    res.setHeader(
      "Content-Type",
      encrypted ? "application/octet-stream" : "application/gzip",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Post("support-export/preview")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Preview the de-identified backup: before/after samples of key tables",
  })
  @ApiResponse({ status: 200, description: "Preview samples returned" })
  async supportExportPreview(
    @Request() req,
    @Body() dto: CreateSupportBackupDto,
  ) {
    return this.supportBackupService.preview(req.user.id, dto);
  }

  @Post("restore")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Restore user data from a backup file (gzipped JSON or encrypted Monize backup)",
  })
  @ApiResponse({ status: 200, description: "Data restored successfully" })
  @ApiResponse({ status: 401, description: "Invalid credentials" })
  @ApiResponse({ status: 400, description: "Invalid backup format" })
  async restoreBackup(@Request() req) {
    const body: unknown = req.body;
    // CodeQL js/type-confusion-through-parameter-tampering doesn't model
    // Buffer.isBuffer as a type guard. Explicit typeof / Array.isArray
    // narrowing rejects the string and array forms body-parser can produce.
    if (
      typeof body === "string" ||
      Array.isArray(body) ||
      !Buffer.isBuffer(body) ||
      body.length === 0
    ) {
      throw new BadRequestException(
        tr(
          "errors.backup.restoreBodyMustBeFile",
          "Request body must be a backup file",
        ),
      );
    }

    const password = decodePasswordHeader(
      req.headers["x-restore-password"] as string | undefined,
    );
    const oidcIdToken = req.headers["x-restore-oidc-token"] as
      | string
      | undefined;
    const backupPassword = decodePasswordHeader(
      req.headers["x-backup-password"] as string | undefined,
    );

    const result = await this.backupService.restoreData(req.user.id, {
      compressedData: body,
      password,
      oidcIdToken,
      backupPassword,
    });
    return result;
  }

  @Get("encryption")
  @ApiOperation({ summary: "Get backup encryption status for current user" })
  @ApiResponse({ status: 200, description: "Encryption status returned" })
  async getEncryptionStatus(@Request() req) {
    return this.backupEncryption.getStatus(req.user.id);
  }

  @Post("encryption/enable-local")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Enable encrypted backups for a local-auth user using their login password",
  })
  @ApiResponse({ status: 200, description: "Encryption enabled" })
  @ApiResponse({ status: 401, description: "Invalid password" })
  async enableLocalEncryption(
    @Request() req,
    @Body() dto: EnableLocalEncryptionDto,
  ) {
    await this.backupEncryption.enableForLocalUser(req.user.id, dto.password);
    return { enabled: true };
  }

  @Post("encryption/backup-password")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Set or update a dedicated backup password (required for OIDC users to enable encryption)",
  })
  @ApiResponse({ status: 200, description: "Backup password set" })
  async setBackupPassword(@Request() req, @Body() dto: SetBackupPasswordDto) {
    await this.backupEncryption.setBackupPasswordForOidcUser(
      req.user.id,
      dto.backupPassword,
    );
    return { enabled: true };
  }

  @Delete("encryption")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Disable encrypted backups" })
  @ApiResponse({ status: 200, description: "Encryption disabled" })
  async disableEncryption(@Request() req) {
    await this.backupEncryption.disable(req.user.id);
    return { enabled: false };
  }

  @Get("auto-backup-settings")
  @ApiOperation({ summary: "Get automatic backup settings" })
  @ApiResponse({ status: 200, description: "Auto-backup settings returned" })
  async getAutoBackupSettings(@Request() req) {
    return this.autoBackupService.getSettings(req.user.id);
  }

  @Patch("auto-backup-settings")
  @DemoRestricted()
  @ApiOperation({ summary: "Update automatic backup settings" })
  @ApiResponse({ status: 200, description: "Settings updated" })
  async updateAutoBackupSettings(
    @Request() req,
    @Body() dto: UpdateAutoBackupSettingsDto,
  ) {
    return this.autoBackupService.updateSettings(req.user.id, dto);
  }

  @Post("validate-folder")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Validate a folder path is writable" })
  @ApiResponse({ status: 200, description: "Validation result" })
  async validateFolder(@Body() dto: ValidateFolderDto) {
    return this.autoBackupService.validateFolder(dto.folderPath);
  }

  @Post("browse-folders")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "List subdirectories in a folder" })
  @ApiResponse({ status: 200, description: "Directory listing" })
  async browseFolders(@Body() dto: ValidateFolderDto) {
    return this.autoBackupService.browseFolders(dto.folderPath);
  }

  @Post("run-auto-backup")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Trigger an immediate automatic backup" })
  @ApiResponse({ status: 200, description: "Backup completed" })
  async runAutoBackup(@Request() req) {
    return this.autoBackupService.runManualBackup(req.user.id);
  }
}
