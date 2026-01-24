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
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { ScheduledTransactionsService } from './scheduled-transactions.service';
import { CreateScheduledTransactionDto } from './dto/create-scheduled-transaction.dto';
import { UpdateScheduledTransactionDto } from './dto/update-scheduled-transaction.dto';

@ApiTags('Scheduled Transactions')
@Controller('scheduled-transactions')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class ScheduledTransactionsController {
  constructor(
    private readonly scheduledTransactionsService: ScheduledTransactionsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new scheduled transaction' })
  @ApiResponse({ status: 201, description: 'Scheduled transaction created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  create(
    @Request() req,
    @Body() createDto: CreateScheduledTransactionDto,
  ) {
    return this.scheduledTransactionsService.create(req.user.id, createDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all scheduled transactions for the authenticated user' })
  @ApiResponse({
    status: 200,
    description: 'List of scheduled transactions retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  findAll(@Request() req) {
    return this.scheduledTransactionsService.findAll(req.user.id);
  }

  @Get('due')
  @ApiOperation({ summary: 'Get all due scheduled transactions' })
  @ApiResponse({
    status: 200,
    description: 'List of due scheduled transactions retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  findDue(@Request() req) {
    return this.scheduledTransactionsService.findDue(req.user.id);
  }

  @Get('upcoming')
  @ApiOperation({ summary: 'Get upcoming scheduled transactions' })
  @ApiQuery({
    name: 'days',
    required: false,
    description: 'Number of days to look ahead (default: 30)',
  })
  @ApiResponse({
    status: 200,
    description: 'List of upcoming scheduled transactions retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  findUpcoming(@Request() req, @Query('days') days?: string) {
    const daysNum = days ? parseInt(days, 10) : 30;
    return this.scheduledTransactionsService.findUpcoming(req.user.id, daysNum);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific scheduled transaction by ID' })
  @ApiParam({ name: 'id', description: 'Scheduled transaction UUID' })
  @ApiResponse({
    status: 200,
    description: 'Scheduled transaction retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - scheduled transaction does not belong to user',
  })
  @ApiResponse({ status: 404, description: 'Scheduled transaction not found' })
  findOne(@Request() req, @Param('id') id: string) {
    return this.scheduledTransactionsService.findOne(req.user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a scheduled transaction' })
  @ApiParam({ name: 'id', description: 'Scheduled transaction UUID' })
  @ApiResponse({
    status: 200,
    description: 'Scheduled transaction updated successfully',
  })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - scheduled transaction does not belong to user',
  })
  @ApiResponse({ status: 404, description: 'Scheduled transaction not found' })
  update(
    @Request() req,
    @Param('id') id: string,
    @Body() updateDto: UpdateScheduledTransactionDto,
  ) {
    return this.scheduledTransactionsService.update(req.user.id, id, updateDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a scheduled transaction' })
  @ApiParam({ name: 'id', description: 'Scheduled transaction UUID' })
  @ApiResponse({ status: 200, description: 'Scheduled transaction deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - scheduled transaction does not belong to user',
  })
  @ApiResponse({ status: 404, description: 'Scheduled transaction not found' })
  remove(@Request() req, @Param('id') id: string) {
    return this.scheduledTransactionsService.remove(req.user.id, id);
  }

  @Post(':id/post')
  @ApiOperation({ summary: 'Post a scheduled transaction (create actual transaction)' })
  @ApiParam({ name: 'id', description: 'Scheduled transaction UUID' })
  @ApiResponse({ status: 200, description: 'Transaction posted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Scheduled transaction not found' })
  post(
    @Request() req,
    @Param('id') id: string,
    @Body('transactionDate') transactionDate?: string,
  ) {
    return this.scheduledTransactionsService.post(req.user.id, id, transactionDate);
  }

  @Post(':id/skip')
  @ApiOperation({ summary: 'Skip this occurrence and advance to next due date' })
  @ApiParam({ name: 'id', description: 'Scheduled transaction UUID' })
  @ApiResponse({ status: 200, description: 'Occurrence skipped successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Scheduled transaction not found' })
  skip(@Request() req, @Param('id') id: string) {
    return this.scheduledTransactionsService.skip(req.user.id, id);
  }
}
