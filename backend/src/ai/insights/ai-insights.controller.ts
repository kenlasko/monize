import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Request,
  UseGuards,
  ParseUUIDPipe,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
} from "@nestjs/swagger";
import { AiInsightsService } from "./ai-insights.service";
import { InsightType, InsightSeverity } from "../entities/ai-insight.entity";

@ApiTags("AI Insights")
@Controller("ai/insights")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class AiInsightsController {
  constructor(private readonly insightsService: AiInsightsService) {}

  @Get()
  @ApiOperation({ summary: "Get spending insights for the current user" })
  @ApiQuery({ name: "type", required: false, description: "Filter by insight type" })
  @ApiQuery({ name: "severity", required: false, description: "Filter by severity" })
  @ApiQuery({ name: "includeDismissed", required: false, description: "Include dismissed insights" })
  getInsights(
    @Request() req: { user: { id: string } },
    @Query("type") type?: InsightType,
    @Query("severity") severity?: InsightSeverity,
    @Query("includeDismissed") includeDismissed?: string,
  ) {
    return this.insightsService.getInsights(
      req.user.id,
      type,
      severity,
      includeDismissed === "true",
    );
  }

  @Post("generate")
  @ApiOperation({ summary: "Generate or refresh spending insights" })
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  generateInsights(@Request() req: { user: { id: string } }) {
    return this.insightsService.generateInsights(req.user.id);
  }

  @Patch(":id/dismiss")
  @ApiOperation({ summary: "Dismiss an insight" })
  @ApiParam({ name: "id", description: "Insight ID" })
  dismissInsight(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.insightsService.dismissInsight(req.user.id, id);
  }
}
