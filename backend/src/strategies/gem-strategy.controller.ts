import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { GemStrategyService } from "./gem-strategy.service";
import { GemReportQueryDto } from "./dto/gem-report-query.dto";
import { CreateGemStrategyDto } from "./dto/create-gem-strategy.dto";
import { UpdateGemStrategyDto } from "./dto/update-gem-strategy.dto";
import { GemStrategyReportView } from "./gem-report.types";
import { AllowPat } from "../auth/pat-access/pat-access.decorator";

@ApiTags("Strategies")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@AllowPat()
@Controller("strategies/gem")
export class GemStrategyController {
  constructor(private readonly gemStrategyService: GemStrategyService) {}

  @Get("report")
  @ApiOperation({
    summary: "Get the GEM strategy report (signal, portfolio fit, history)",
  })
  @ApiResponse({ status: 200, description: "GEM strategy report" })
  getReport(
    @Request() req,
    @Query() query: GemReportQueryDto,
  ): Promise<GemStrategyReportView> {
    return this.gemStrategyService.getReport(
      req.user.id,
      query.range ?? "1Y",
      query.strategyId,
    );
  }

  @Put()
  @ApiOperation({
    summary: "Create or update the GEM strategy configuration",
  })
  @ApiResponse({ status: 200, description: "Refreshed GEM strategy report" })
  @ApiResponse({ status: 404, description: "Account or security not found" })
  updateConfig(
    @Request() req,
    @Body() dto: UpdateGemStrategyDto,
    @Query() query: GemReportQueryDto,
  ): Promise<GemStrategyReportView> {
    return this.gemStrategyService.updateConfig(
      req.user.id,
      dto,
      query.range ?? "1Y",
      query.strategyId,
    );
  }

  @Post()
  @ApiOperation({ summary: "Start a new GEM scenario" })
  @ApiResponse({ status: 201, description: "Report for the new scenario" })
  createStrategy(
    @Request() req,
    @Body() dto: CreateGemStrategyDto,
    @Query() query: GemReportQueryDto,
  ): Promise<GemStrategyReportView> {
    return this.gemStrategyService.createStrategy(
      req.user.id,
      dto.name,
      query.range ?? "1Y",
    );
  }

  @Delete(":id")
  @ApiOperation({
    summary: "Delete a GEM scenario, with its assignments and history",
  })
  @ApiResponse({ status: 200, description: "Report for a remaining scenario" })
  @ApiResponse({ status: 404, description: "Strategy not found" })
  removeStrategy(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: GemReportQueryDto,
  ): Promise<GemStrategyReportView> {
    return this.gemStrategyService.removeStrategy(
      req.user.id,
      id,
      query.range ?? "1Y",
    );
  }

  @Post("signals/:id/executed")
  @ApiOperation({
    summary: "Mark a signal's operation as carried out",
  })
  @ApiResponse({ status: 201, description: "Refreshed GEM strategy report" })
  @ApiResponse({ status: 404, description: "Signal not found" })
  markExecuted(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: GemReportQueryDto,
  ): Promise<GemStrategyReportView> {
    return this.gemStrategyService.markExecuted(
      req.user.id,
      id,
      query.range ?? "1Y",
      query.strategyId,
    );
  }
}
