import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
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
import { AiService } from "./ai.service";
import { CreateAiConfigDto, UpdateAiConfigDto } from "./dto/ai-config.dto";

@ApiTags("AI")
@Controller("ai")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get("status")
  @ApiOperation({ summary: "Get AI feature availability status" })
  getStatus(@Request() req: { user: { id: string } }) {
    return this.aiService.getStatus(req.user.id);
  }

  @Get("configs")
  @ApiOperation({ summary: "List all AI provider configurations" })
  getConfigs(@Request() req: { user: { id: string } }) {
    return this.aiService.getConfigs(req.user.id);
  }

  @Post("configs")
  @ApiOperation({ summary: "Add a new AI provider configuration" })
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  createConfig(
    @Request() req: { user: { id: string } },
    @Body() dto: CreateAiConfigDto,
  ) {
    return this.aiService.createConfig(req.user.id, dto);
  }

  @Patch("configs/:id")
  @ApiOperation({ summary: "Update an AI provider configuration" })
  @ApiParam({ name: "id", description: "Configuration ID" })
  updateConfig(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateAiConfigDto,
  ) {
    return this.aiService.updateConfig(req.user.id, id, dto);
  }

  @Delete("configs/:id")
  @ApiOperation({ summary: "Delete an AI provider configuration" })
  @ApiParam({ name: "id", description: "Configuration ID" })
  deleteConfig(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.aiService.deleteConfig(req.user.id, id);
  }

  @Post("configs/:id/test")
  @ApiOperation({ summary: "Test connection to an AI provider" })
  @ApiParam({ name: "id", description: "Configuration ID" })
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  testConnection(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.aiService.testConnection(req.user.id, id);
  }

  @Get("usage")
  @ApiOperation({ summary: "Get AI usage summary" })
  @ApiQuery({
    name: "days",
    required: false,
    description: "Number of days to include (default: all time)",
  })
  getUsage(
    @Request() req: { user: { id: string } },
    @Query("days") days?: string,
  ) {
    const parsedDays = days ? parseInt(days, 10) : undefined;
    return this.aiService.getUsageSummary(
      req.user.id,
      parsedDays && !isNaN(parsedDays) ? parsedDays : undefined,
    );
  }
}
