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
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { SharedFinanceService } from "./shared-finance.service";
import {
  BookSharedEntryDto,
  EnableSharedFinanceDto,
} from "./dto/shared-finance.dto";
import { SharedCommandDto } from "./dto/shared-command.dto";
import { SharedFinanceDeferredGuard } from "./shared-finance-deferred.guard";

type SharedRequest = { user: { id: string } };

@ApiTags("Shared expenses: private finances")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("shared-expenses/groups/:groupId/finances")
export class SharedFinanceController {
  constructor(private readonly finance: SharedFinanceService) {}

  @Get()
  overview(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
  ) {
    return this.finance.overview(req.user.id, groupId);
  }

  @Post("enable")
  @UseGuards(SharedFinanceDeferredGuard)
  enable(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Body() dto: EnableSharedFinanceDto,
  ) {
    return this.finance.enable(req.user.id, groupId, dto);
  }

  @Post("entries/:entryId/preview")
  @UseGuards(SharedFinanceDeferredGuard)
  preview(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
    @Body() dto: BookSharedEntryDto,
  ) {
    return this.finance.preview(req.user.id, groupId, entryId, dto);
  }

  @Post("entries/:entryId/book")
  @UseGuards(SharedFinanceDeferredGuard)
  book(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
    @Body() dto: BookSharedEntryDto,
  ) {
    return this.finance.book(req.user.id, groupId, entryId, dto);
  }

  @Post("entries/:entryId/unlink")
  unlink(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
    @Body() dto: SharedCommandDto,
  ) {
    return this.finance.unlink(req.user.id, groupId, entryId, dto);
  }
}
