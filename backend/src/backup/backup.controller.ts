import {
  Controller,
  Post,
  Get,
  Patch,
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
import {
  UpdateAutoBackupSettingsDto,
  ValidateFolderDto,
} from "./dto/update-auto-backup-settings.dto";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";

@ApiTags("Backup")
@Controller("backup")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class BackupController {
  constructor(
    private readonly backupService: BackupService,
    private readonly autoBackupService: AutoBackupService,
  ) {}

  @Post("export")
  @DemoRestricted()
  @ApiOperation({ summary: "Export all user data as JSON backup" })
  @ApiResponse({ status: 200, description: "Backup file downloaded" })
  async exportBackup(@Request() req, @Res() res: Response) {
    const filename = `monize-backup-${new Date().toISOString().slice(0, 10)}.json.gz`;

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await this.backupService.streamExport(req.user.id, res);
  }

  @Post("restore")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Restore user data from gzip-compressed JSON backup",
  })
  @ApiResponse({ status: 200, description: "Data restored successfully" })
  @ApiResponse({ status: 401, description: "Invalid credentials" })
  @ApiResponse({ status: 400, description: "Invalid backup format" })
  async restoreBackup(@Request() req) {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new BadRequestException(
        "Request body must be a gzip-compressed backup file",
      );
    }

    const password = req.headers["x-restore-password"] as string | undefined;
    const oidcIdToken = req.headers["x-restore-oidc-token"] as
      | string
      | undefined;

    const result = await this.backupService.restoreData(req.user.id, {
      compressedData: body,
      password,
      oidcIdToken,
    });
    return result;
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
