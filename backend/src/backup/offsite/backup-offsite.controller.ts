import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Patch,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { DemoRestricted } from "../../common/decorators/demo-restricted.decorator";
import { BackupOffsiteSettingsService } from "./backup-offsite-settings.service";
import { UpdateBackupOffsiteSettingsDto } from "./dto/update-backup-offsite-settings.dto";

/** The largest page of upload rows a caller may ask for. */
const MAX_UPLOAD_LIMIT = 200;

/**
 * Where one user's completed automatic backups are copied to, and how the last
 * few copies went (`docs/specs/backup-off-machine.md` section 9).
 *
 * Unlike `AutoBackupController`, this is **not** admin-only. The schedule and
 * the folder are an operator's decision about the server's disk; a destination
 * is the user's decision about their own data leaving the machine -- their
 * bucket, their credentials, their email address -- so every authenticated user
 * manages their own. `userId` comes from the verified JWT on every route and is
 * never read from the body, so there is no shape of request that reaches
 * somebody else's row.
 */
@ApiTags("Backup")
@Controller("backup")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class BackupOffsiteController {
  constructor(private readonly offsiteSettings: BackupOffsiteSettingsService) {}

  @Get("offsite-settings")
  @ApiOperation({ summary: "Get your off-site backup destinations" })
  @ApiResponse({
    status: 200,
    description:
      "Destinations returned. Stored credentials are reported as set or unset, never returned.",
  })
  async getOffsiteSettings(@Request() req) {
    return this.offsiteSettings.getView(req.user.id);
  }

  @Patch("offsite-settings")
  @DemoRestricted()
  @ApiOperation({ summary: "Update your off-site backup destinations" })
  @ApiResponse({ status: 200, description: "Destinations updated" })
  @ApiResponse({
    status: 400,
    description:
      "The destination would not be usable: no deployment bucket, an incomplete own bucket, no encryption key, or email enabled with no address",
  })
  async updateOffsiteSettings(
    @Request() req,
    @Body() dto: UpdateBackupOffsiteSettingsDto,
  ) {
    return this.offsiteSettings.update(req.user.id, dto);
  }

  @Get("offsite-uploads")
  @ApiOperation({ summary: "List your recent off-site backup copies" })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    description: `Rows to return, newest first (default: 50, maximum: ${MAX_UPLOAD_LIMIT})`,
  })
  @ApiResponse({ status: 200, description: "Copies returned, newest first" })
  async listOffsiteUploads(
    @Request() req,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    const safeLimit = Math.min(Math.max(limit, 1), MAX_UPLOAD_LIMIT);
    return this.offsiteSettings.listUploads(req.user.id, safeLimit);
  }
}
