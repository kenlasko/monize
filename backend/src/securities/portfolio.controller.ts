import {
  Controller,
  Get,
  UseGuards,
  Request,
  Query,
  BadRequestException,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiQuery,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { PortfolioService } from "./portfolio.service";

@ApiTags("Portfolio")
@Controller("portfolio")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class PortfolioController {
  private static readonly UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  constructor(private readonly portfolioService: PortfolioService) {}

  private parseAccountIds(accountIds?: string): string[] | undefined {
    if (!accountIds) return undefined;
    const ids = accountIds.split(",").filter(Boolean);
    for (const id of ids) {
      if (!PortfolioController.UUID_REGEX.test(id)) {
        throw new BadRequestException(`Invalid account UUID: ${id}`);
      }
    }
    return ids;
  }

  @Get("summary")
  @ApiOperation({
    summary: "Get portfolio summary with holdings and market values",
  })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Comma-separated account IDs to filter by (will include linked pairs)",
  })
  @ApiResponse({
    status: 200,
    description: "Portfolio summary retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getSummary(@Request() req, @Query("accountIds") accountIds?: string) {
    const ids = this.parseAccountIds(accountIds);
    return this.portfolioService.getPortfolioSummary(req.user.id, ids);
  }

  @Get("allocation")
  @ApiOperation({
    summary: "Get asset allocation breakdown",
  })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Comma-separated account IDs to filter by (will include linked pairs)",
  })
  @ApiResponse({
    status: 200,
    description: "Asset allocation retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getAllocation(@Request() req, @Query("accountIds") accountIds?: string) {
    const ids = this.parseAccountIds(accountIds);
    return this.portfolioService.getAssetAllocation(req.user.id, ids);
  }

  @Get("top-movers")
  @ApiOperation({
    summary: "Get top daily movers among held securities",
  })
  @ApiResponse({
    status: 200,
    description: "Top movers retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getTopMovers(@Request() req) {
    return this.portfolioService.getTopMovers(req.user.id);
  }

  @Get("accounts")
  @ApiOperation({
    summary: "Get all investment accounts for the user",
  })
  @ApiResponse({
    status: 200,
    description: "Investment accounts retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getInvestmentAccounts(@Request() req) {
    return this.portfolioService.getInvestmentAccounts(req.user.id);
  }
}
