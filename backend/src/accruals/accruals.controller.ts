import { AccrualSystemMovementsQueryDto } from "./dto/accrual-system-movements-query.dto";
import { AccrualSourcesDto } from "./dto/accrual-sources.dto";
import { ReportingDetailsQueryDto } from "./dto/reporting-details-query.dto";
import { ReportingEndpoint } from "./reporting-endpoint";
import { AccrualSystemBalancesQueryDto } from "./dto/accrual-system-balances-query.dto";
import { AccrualSourceEditDto } from "./dto/accrual-source-edit.dto";
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Query,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { AccrualsService } from "./accruals.service";
import {
  AccrualPreviewDto,
  AccrualCommitDto,
  AccrualRemoveDto,
} from "./dto/accrual-command.dto";

type AuthedRequest = { user: { id: string } };

@ApiTags("Accruals")
@ApiBearerAuth()
@Controller("accruals")
@UseGuards(AuthGuard("jwt"))
export class AccrualsController {
  constructor(private readonly accruals: AccrualsService) {}
  @Post("sources")
  sources(@Request() req: AuthedRequest, @Body() dto: AccrualSourcesDto) {
    return this.accruals.sources(req.user.id, dto.sourceTransactionIds);
  }
  @Post("source-preview")
  sourcePreview(
    @Request() req: AuthedRequest,
    @Body() dto: AccrualSourceEditDto,
  ) {
    return this.accruals.previewSourceEdit(
      req.user.id,
      dto.sourceTransactionId,
      dto.patch,
    );
  }
  @Post("preview")
  preview(@Request() req: AuthedRequest, @Body() dto: AccrualPreviewDto) {
    return this.accruals.preview(req.user.id, dto);
  }
  @Post()
  @DemoRestricted()
  save(@Request() req: AuthedRequest, @Body() dto: AccrualCommitDto) {
    return this.accruals.save(req.user.id, dto);
  }
  @Get("source/:id")
  sourceSchedules(
    @Request() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.accruals.sourceSchedules(req.user.id, id);
  }
  @Get("reporting-details")
  @ReportingEndpoint()
  reportingDetails(
    @Request() req: AuthedRequest,
    @Query() query: ReportingDetailsQueryDto,
  ) {
    return this.accruals.reportingDetails(req.user.id, query);
  }
  @Get("system-balances")
  systemBalances(
    @Request() req: AuthedRequest,
    @Query() query: AccrualSystemBalancesQueryDto,
  ) {
    return this.accruals.systemBalances(
      req.user.id,
      query.asOf,
      query.accountIds,
    );
  }
  @Get("system-accounts/:id/movements")
  systemMovements(
    @Request() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: AccrualSystemMovementsQueryDto,
  ) {
    return this.accruals.systemMovements(req.user.id, id, query);
  }
  @Get(":id")
  detail(
    @Request() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.accruals.detail(req.user.id, id);
  }
  @Delete(":id")
  @DemoRestricted()
  remove(
    @Request() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AccrualRemoveDto,
  ) {
    return this.accruals.remove(req.user.id, id, dto);
  }
}
