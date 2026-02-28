import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

@ApiTags("Health")
@SkipThrottle()
@Controller("health")
export class HealthController {
  constructor(
    @InjectDataSource()
    private dataSource: DataSource,
  ) {}

  @Get()
  @ApiOperation({ summary: "Health check endpoint" })
  async check() {
    const dbHealthy = await this.checkDatabase();

    return {
      status: dbHealthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      checks: {
        database: dbHealthy ? "healthy" : "unhealthy",
      },
    };
  }

  @Get("live")
  @ApiOperation({ summary: "Liveness probe - is the app running?" })
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  @ApiOperation({
    summary: "Readiness probe - is the app ready to serve traffic?",
  })
  async ready() {
    const dbHealthy = await this.checkDatabase();

    if (!dbHealthy) {
      throw new ServiceUnavailableException("Service not ready");
    }

    return { status: "ok" };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.dataSource.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}
