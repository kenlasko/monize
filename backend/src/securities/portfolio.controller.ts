import {
  Controller,
  Get,
  UseGuards,
  Request,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { PortfolioService } from './portfolio.service';

@ApiTags('Portfolio')
@Controller('portfolio')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Get portfolio summary with holdings and market values',
  })
  @ApiQuery({
    name: 'accountId',
    required: false,
    description:
      'Filter by investment account ID (will include linked pair)',
  })
  @ApiResponse({
    status: 200,
    description: 'Portfolio summary retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getSummary(@Request() req, @Query('accountId') accountId?: string) {
    return this.portfolioService.getPortfolioSummary(req.user.id, accountId);
  }

  @Get('allocation')
  @ApiOperation({
    summary: 'Get asset allocation breakdown',
  })
  @ApiQuery({
    name: 'accountId',
    required: false,
    description:
      'Filter by investment account ID (will include linked pair)',
  })
  @ApiResponse({
    status: 200,
    description: 'Asset allocation retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getAllocation(@Request() req, @Query('accountId') accountId?: string) {
    return this.portfolioService.getAssetAllocation(req.user.id, accountId);
  }

  @Get('accounts')
  @ApiOperation({
    summary: 'Get all investment accounts for the user',
  })
  @ApiResponse({
    status: 200,
    description: 'Investment accounts retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getInvestmentAccounts(@Request() req) {
    return this.portfolioService.getInvestmentAccounts(req.user.id);
  }
}
