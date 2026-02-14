import {
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  Request,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from "@nestjs/swagger";
import { NetWorthService } from "./net-worth.service";

@ApiTags("Net Worth")
@Controller("net-worth")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class NetWorthController {
  constructor(private readonly netWorthService: NetWorthService) {}

  @Get("monthly")
  @ApiOperation({ summary: "Get monthly net worth data" })
  @ApiQuery({ name: "startDate", required: false, example: "2023-01-01" })
  @ApiQuery({ name: "endDate", required: false, example: "2024-12-31" })
  @ApiResponse({ status: 200, description: "Monthly net worth data" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getMonthlyNetWorth(
    @Request() req,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    return this.netWorthService.getMonthlyNetWorth(
      req.user.id,
      startDate,
      endDate,
    );
  }

  @Get("investments-monthly")
  @ApiOperation({ summary: "Get monthly investment portfolio value" })
  @ApiQuery({ name: "startDate", required: false, example: "2023-01-01" })
  @ApiQuery({ name: "endDate", required: false, example: "2024-12-31" })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Comma-separated account IDs to filter by (will include linked pairs)",
  })
  @ApiQuery({
    name: "displayCurrency",
    required: false,
    description:
      "Currency code to display values in (defaults to user preference)",
  })
  @ApiResponse({ status: 200, description: "Monthly investment value data" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getMonthlyInvestments(
    @Request() req,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("accountIds") accountIds?: string,
    @Query("displayCurrency") displayCurrency?: string,
  ) {
    const ids = accountIds ? accountIds.split(",").filter(Boolean) : undefined;
    return this.netWorthService.getMonthlyInvestments(
      req.user.id,
      startDate,
      endDate,
      ids,
      displayCurrency,
    );
  }

  @Post("recalculate")
  @ApiOperation({ summary: "Trigger full net worth recalculation" })
  @ApiResponse({ status: 201, description: "Recalculation triggered" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async recalculate(@Request() req) {
    await this.netWorthService.recalculateAllAccounts(req.user.id);
    return { success: true };
  }
}
