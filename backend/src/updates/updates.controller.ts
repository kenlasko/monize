import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { UpdateStatus, UpdatesService } from "./updates.service";

@ApiTags("Updates")
@ApiBearerAuth()
@Controller("updates")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles("admin")
export class UpdatesController {
  constructor(private readonly updatesService: UpdatesService) {}

  @Get("status")
  @ApiOperation({
    summary:
      "Get upstream update status (admin only). Returns current vs. latest GitHub release.",
  })
  getStatus(@Request() req): Promise<UpdateStatus> {
    return this.updatesService.getStatus(req.user.id);
  }

  @Post("dismiss")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Dismiss the update banner for the current latest version (admin only).",
  })
  dismiss(@Request() req) {
    return this.updatesService.dismiss(req.user.id);
  }
}
