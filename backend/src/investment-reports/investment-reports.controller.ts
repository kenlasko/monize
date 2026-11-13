import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Request,
  ParseUUIDPipe,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from "@nestjs/swagger";
import { InvestmentReportsService } from "./investment-reports.service";
import { CreateInvestmentReportDto } from "./dto/create-investment-report.dto";
import { UpdateInvestmentReportDto } from "./dto/update-investment-report.dto";
import { ExecuteInvestmentReportDto } from "./dto/execute-investment-report.dto";
import { InvestmentReport } from "./entities/investment-report.entity";
import {
  AllowDelegate,
  DelegateRequiresSection,
} from "../delegation/decorators/delegate-access.decorator";
import { AllowPat, PatScope } from "../auth/pat-access/pat-access.decorator";

@ApiTags("Investment Reports")
@AllowPat()
@Controller("reports/investment")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
// Read-only section for delegates: only the @AllowDelegate() GETs are
// reachable, and only with the "reports" section grant. Writes fail closed.
@DelegateRequiresSection("reports")
export class InvestmentReportsController {
  constructor(
    private readonly investmentReportsService: InvestmentReportsService,
  ) {}

  @Post()
  @ApiOperation({ summary: "Create a new investment report" })
  @ApiResponse({ status: 201, type: InvestmentReport })
  create(
    @Request() req,
    @Body() dto: CreateInvestmentReportDto,
  ): Promise<InvestmentReport> {
    return this.investmentReportsService.create(req.user.id, dto);
  }

  @Get()
  @AllowDelegate()
  @ApiOperation({ summary: "Get all investment reports for the current user" })
  @ApiResponse({ status: 200, type: [InvestmentReport] })
  findAll(@Request() req): Promise<InvestmentReport[]> {
    return this.investmentReportsService.findAll(req.user.id);
  }

  @Get(":id")
  @AllowDelegate()
  @ApiOperation({ summary: "Get a specific investment report by ID" })
  @ApiParam({ name: "id", description: "Report ID" })
  @ApiResponse({ status: 200, type: InvestmentReport })
  @ApiResponse({ status: 404, description: "Report not found" })
  findOne(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<InvestmentReport> {
    return this.investmentReportsService.findOne(req.user.id, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update an investment report" })
  @ApiParam({ name: "id", description: "Report ID" })
  @ApiResponse({ status: 200, type: InvestmentReport })
  @ApiResponse({ status: 404, description: "Report not found" })
  update(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateInvestmentReportDto,
  ): Promise<InvestmentReport> {
    return this.investmentReportsService.update(req.user.id, id, dto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete an investment report" })
  @ApiParam({ name: "id", description: "Report ID" })
  @ApiResponse({ status: 200, description: "Report deleted" })
  @ApiResponse({ status: 404, description: "Report not found" })
  remove(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.investmentReportsService.remove(req.user.id, id);
  }

  @Post(":id/execute")
  @PatScope("read")
  @ApiOperation({ summary: "Run an investment report and get its rows" })
  @ApiParam({ name: "id", description: "Report ID" })
  @ApiResponse({ status: 200, description: "Report execution result" })
  @ApiResponse({ status: 404, description: "Report not found" })
  execute(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ExecuteInvestmentReportDto,
  ) {
    return this.investmentReportsService.execute(req.user.id, id, dto);
  }
}
