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
  HttpCode,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from "@nestjs/swagger";
import { AiInsightsService } from "./ai-insights.service";
import { GetInsightsQueryDto } from "./dto/ai-insights.dto";
import { InsightType } from "../entities/ai-insight.entity";

@ApiTags("AI Insights")
@Controller("ai/insights")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class AiInsightsController {
  private readonly logger = new Logger(AiInsightsController.name);

  constructor(private readonly insightsService: AiInsightsService) {}

  @Get()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: "Get spending insights for the current user" })
  getInsights(
    @Request() req: { user: { id: string } },
    @Query() query: GetInsightsQueryDto,
  ) {
    return this.insightsService.getInsights(
      req.user.id,
      query.type as InsightType | undefined,
      query.severity,
      query.includeDismissed === true,
    );
  }

  @Post("generate")
  @ApiOperation({
    summary: "Trigger background generation of spending insights",
  })
  @ApiResponse({
    status: 202,
    description: "Generation started in the background",
  })
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @HttpCode(HttpStatus.ACCEPTED)
  triggerGeneration(@Request() req: { user: { id: string } }) {
    const userId = req.user.id;
    this.insightsService.generateInsights(userId).catch((error) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.error(
        `Background insight generation failed for user ${userId}: ${message}`,
      );
    });
    return { status: "generating" };
  }

  @Patch(":id/dismiss")
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: "Dismiss an insight" })
  @ApiParam({ name: "id", description: "Insight ID" })
  dismissInsight(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.insightsService.dismissInsight(req.user.id, id);
  }
}
