import {
  Controller,
  Get,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { ActionHistoryService } from "./action-history.service";
import { ActionHistoryQueryDto } from "./dto/action-history-response.dto";

@ApiTags("Action History")
@Controller("action-history")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class ActionHistoryController {
  constructor(private readonly actionHistoryService: ActionHistoryService) {}

  @Get()
  @ApiOperation({ summary: "Get recent action history for the user" })
  @ApiResponse({ status: 200, description: "Action history retrieved" })
  getHistory(@Request() req, @Query() query: ActionHistoryQueryDto) {
    return this.actionHistoryService.getHistory(req.user.id, query.limit);
  }

  @Post("undo")
  @ApiOperation({ summary: "Undo the most recent action" })
  @ApiResponse({ status: 200, description: "Action undone successfully" })
  @ApiResponse({ status: 404, description: "Nothing to undo" })
  undo(@Request() req) {
    return this.actionHistoryService.undo(req.user.id);
  }

  @Post("redo")
  @ApiOperation({ summary: "Redo the most recently undone action" })
  @ApiResponse({ status: 200, description: "Action redone successfully" })
  @ApiResponse({ status: 404, description: "Nothing to redo" })
  redo(@Request() req) {
    return this.actionHistoryService.redo(req.user.id);
  }
}
