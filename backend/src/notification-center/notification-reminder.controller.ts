import { OwnerOnly } from "../delegation/decorators/delegate-access.decorator";
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";

import { NotificationReminderService } from "./notification-reminder.service";
import { CreateNotificationReminderDto } from "./dto/create-notification-reminder.dto";
import { AllowPat } from "../auth/pat-access/pat-access.decorator";

/**
 * A user's own reminders: ask to be nagged about a notification, list the active
 * ones, and stop one. Personal settings only -- `userId` is the JWT's, never a
 * param -- and the stop is the endpoint the service worker's push Stop action
 * calls (Phase 5), which is why it is a POST that succeeds idempotently.
 */
@ApiTags("Notifications")
@AllowPat()
@Controller("notifications/reminders")
@UseGuards(AuthGuard("jwt"))
@OwnerOnly()
@ApiBearerAuth()
export class NotificationReminderController {
  constructor(private readonly reminders: NotificationReminderService) {}

  @Post()
  @ApiOperation({ summary: "Create a reminder for one of my notifications" })
  @ApiResponse({ status: 201, description: "Reminder created" })
  @ApiResponse({ status: 404, description: "Source notification not found" })
  create(
    @Request() req: { user: { id: string } },
    @Body() dto: CreateNotificationReminderDto,
  ) {
    return this.reminders.create(req.user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: "List my active reminders" })
  @ApiResponse({ status: 200, description: "Reminders retrieved" })
  list(@Request() req: { user: { id: string } }) {
    return this.reminders.list(req.user.id);
  }

  @Post(":id/stop")
  @ApiOperation({ summary: "Stop a reminder (idempotent)" })
  @ApiParam({ name: "id", description: "Reminder UUID" })
  @ApiResponse({
    status: 201,
    description: "Reminder stopped (or already was)",
  })
  stop(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.reminders.stop(req.user.id, id);
  }
}
