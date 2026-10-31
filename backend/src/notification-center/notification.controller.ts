import { SharedNotificationsService } from "../shared-expenses/shared-notifications.service";
import {
  Controller,
  Delete,
  Get,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";

import { NotificationService } from "./notification.service";
import { DismissNotificationsQueryDto } from "./dto/dismiss-notifications-query.dto";
import { BudgetsService } from "../budgets/budgets.service";
import {
  AllowDelegate,
  OwnerOnly,
  DelegateRequiresSection,
} from "../delegation/decorators/delegate-access.decorator";

/**
 * The notification centre: what this account has been told, and what it has
 * done about it.
 *
 * Delegates with the Budgets section may read the existing notification feed.
 * Read state, dismissal and delivery settings belong to the owner. The explicit
 * class policy also protects future routes; only list opts into delegate access.
 * See notification-preferences.md: Delegate access policy (TODO 10).
 */
@ApiTags("Notifications")
@Controller("notifications")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
@DelegateRequiresSection("budgets")
@OwnerOnly()
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly shared: SharedNotificationsService,
    // Bill reminders are materialized on read rather than by a cron, so the
    // list endpoint asks their producer and shared-expense delivery to catch up.
    // Those producer edges belong to this controller's own module -- see
    // `notification-api.module.ts`.
    private readonly budgets: BudgetsService,
  ) {}

  @Get()
  @AllowDelegate()
  @ApiOperation({ summary: "Get this account's live notifications" })
  @ApiQuery({
    name: "unreadOnly",
    required: false,
    type: Boolean,
    description: "Only return unread notifications",
  })
  @ApiResponse({ status: 200, description: "Notifications retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async list(
    @Request() req,
    @Query("unreadOnly", new ParseBoolPipe({ optional: true }))
    unreadOnly?: boolean,
  ) {
    // Only the owner's full list materializes pending bill reminders. `unreadOnly` has
    // no client today -- the bell reads the full list once and counts unread
    // rows itself -- so this branch exists for a caller that wants the count
    // without a write, and is kept honest by the controller spec rather than by
    // a comment claiming a caller it does not have.
    if (!unreadOnly && !req.user.isActing) {
      await this.budgets.ensureBillDueNotifications(req.user.id);
      await this.shared.deliver();
    }
    return this.notifications.list(req.user.id, {
      unreadOnly: unreadOnly || false,
    });
  }

  @Patch(":id/read")
  @ApiOperation({ summary: "Mark a notification as read" })
  @ApiParam({ name: "id", description: "Notification UUID" })
  @ApiResponse({ status: 200, description: "Notification marked as read" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Notification not found" })
  markRead(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.notifications.markRead(req.user.id, id);
  }

  @Patch("read-all")
  @ApiOperation({ summary: "Mark all notifications as read" })
  @ApiResponse({ status: 200, description: "All notifications marked as read" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  markAllRead(@Request() req) {
    return this.notifications.markAllRead(req.user.id);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Dismiss a notification" })
  @ApiParam({ name: "id", description: "Notification UUID" })
  @ApiResponse({ status: 200, description: "Notification dismissed" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Notification not found" })
  dismiss(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.notifications.dismiss(req.user.id, id);
  }

  @Delete()
  @ApiOperation({
    summary: "Dismiss every notification matching the given filter",
  })
  @ApiQuery({
    name: "severity",
    required: false,
    enum: ["info", "warning", "critical", "success"],
    description: "Only dismiss notifications of this severity",
  })
  @ApiQuery({
    name: "category",
    required: false,
    enum: ["system", "financial"],
    description: "Only dismiss system or financial notifications",
  })
  @ApiResponse({ status: 200, description: "Matching notifications dismissed" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  dismissAll(@Request() req, @Query() query: DismissNotificationsQueryDto) {
    return this.notifications.dismissAll(req.user.id, query);
  }
}
