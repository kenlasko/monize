import { Controller, Post, Body, Request, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { AiForecastService } from "./ai-forecast.service";
import { ForecastRequestDto } from "./dto/ai-forecast.dto";

@ApiTags("AI Forecast")
@Controller("ai/forecast")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class AiForecastController {
  constructor(private readonly forecastService: AiForecastService) {}

  @Post()
  @ApiOperation({ summary: "Generate AI-powered cash flow forecast" })
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  generateForecast(
    @Request() req: { user: { id: string } },
    @Body() dto: ForecastRequestDto,
  ) {
    return this.forecastService.generateForecast(req.user.id, dto.months);
  }
}
