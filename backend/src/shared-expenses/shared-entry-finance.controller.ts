import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { SharedEntryFinanceService } from "./shared-entry-finance.service";
import { SaveSharedEntryFinanceDto } from "./dto/shared-entry-finance.dto";
import { SharedNotificationsInterceptor } from "./shared-notifications.interceptor";
import { SharedFinanceDeferredGuard } from "./shared-finance-deferred.guard";

@ApiTags("Shared expenses")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"), SharedFinanceDeferredGuard)
@UseInterceptors(SharedNotificationsInterceptor)
@Controller("shared-expenses/groups/:groupId/entry-finances")
export class SharedEntryFinanceController {
  constructor(private readonly service: SharedEntryFinanceService) {}
  @Post("preview")
  preview(
    @Request() req: { user: { id: string } },
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Body() dto: SaveSharedEntryFinanceDto,
  ) {
    return this.service.preview(req.user.id, groupId, dto);
  }
  @Post()
  save(
    @Request() req: { user: { id: string } },
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Body() dto: SaveSharedEntryFinanceDto,
  ) {
    return this.service.save(req.user.id, groupId, dto);
  }
}
