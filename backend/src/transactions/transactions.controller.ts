import {
  Controller,
  Get,
  Post,
  Put,
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
import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { CreateTransactionSplitDto } from './dto/create-transaction-split.dto';
import { CreateTransferDto } from './dto/create-transfer.dto';

@ApiTags('Transactions')
@Controller('transactions')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new transaction' })
  @ApiResponse({ status: 201, description: 'Transaction created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  create(@Request() req, @Body() createTransactionDto: CreateTransactionDto) {
    return this.transactionsService.create(req.user.id, createTransactionDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all transactions for the authenticated user' })
  @ApiQuery({
    name: 'accountId',
    required: false,
    description: 'Filter by account ID',
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    description: 'Filter by start date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    description: 'Filter by end date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'categoryId',
    required: false,
    description: 'Filter by category ID (also matches split transactions with this category)',
  })
  @ApiQuery({
    name: 'payeeId',
    required: false,
    description: 'Filter by payee ID',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number (1-indexed, default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Number of transactions per page (default: 50, max: 200)',
  })
  @ApiResponse({
    status: 200,
    description: 'List of transactions retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  findAll(
    @Request() req,
    @Query('accountId') accountId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('categoryId') categoryId?: string,
    @Query('payeeId') payeeId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.transactionsService.findAll(
      req.user.id,
      accountId,
      startDate,
      endDate,
      categoryId,
      payeeId,
      page ? parseInt(page, 10) : undefined,
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  @Get('summary')
  @ApiOperation({ summary: 'Get transaction summary statistics' })
  @ApiQuery({
    name: 'accountId',
    required: false,
    description: 'Filter by account ID',
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    description: 'Filter by start date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    description: 'Filter by end date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'categoryId',
    required: false,
    description: 'Filter by category ID',
  })
  @ApiQuery({
    name: 'payeeId',
    required: false,
    description: 'Filter by payee ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Transaction summary retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getSummary(
    @Request() req,
    @Query('accountId') accountId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('categoryId') categoryId?: string,
    @Query('payeeId') payeeId?: string,
  ) {
    return this.transactionsService.getSummary(
      req.user.id,
      accountId,
      startDate,
      endDate,
      categoryId,
      payeeId,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific transaction by ID' })
  @ApiParam({ name: 'id', description: 'Transaction UUID' })
  @ApiResponse({
    status: 200,
    description: 'Transaction retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - transaction does not belong to user',
  })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  findOne(@Request() req, @Param('id') id: string) {
    return this.transactionsService.findOne(req.user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a transaction' })
  @ApiParam({ name: 'id', description: 'Transaction UUID' })
  @ApiResponse({
    status: 200,
    description: 'Transaction updated successfully',
  })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - transaction does not belong to user',
  })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  update(
    @Request() req,
    @Param('id') id: string,
    @Body() updateTransactionDto: UpdateTransactionDto,
  ) {
    return this.transactionsService.update(req.user.id, id, updateTransactionDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a transaction' })
  @ApiParam({ name: 'id', description: 'Transaction UUID' })
  @ApiResponse({ status: 200, description: 'Transaction deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - transaction does not belong to user',
  })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  remove(@Request() req, @Param('id') id: string) {
    return this.transactionsService.remove(req.user.id, id);
  }

  @Post(':id/clear')
  @ApiOperation({ summary: 'Mark transaction as cleared or uncleared' })
  @ApiParam({ name: 'id', description: 'Transaction UUID' })
  @ApiResponse({ status: 200, description: 'Transaction cleared status updated' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  markCleared(
    @Request() req,
    @Param('id') id: string,
    @Body('isCleared') isCleared: boolean,
  ) {
    return this.transactionsService.markCleared(req.user.id, id, isCleared);
  }

  @Post(':id/reconcile')
  @ApiOperation({ summary: 'Reconcile a transaction' })
  @ApiParam({ name: 'id', description: 'Transaction UUID' })
  @ApiResponse({ status: 200, description: 'Transaction reconciled successfully' })
  @ApiResponse({ status: 400, description: 'Transaction already reconciled' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  reconcile(@Request() req, @Param('id') id: string) {
    return this.transactionsService.reconcile(req.user.id, id);
  }

  @Post(':id/unreconcile')
  @ApiOperation({ summary: 'Unreconcile a transaction' })
  @ApiParam({ name: 'id', description: 'Transaction UUID' })
  @ApiResponse({
    status: 200,
    description: 'Transaction unreconciled successfully',
  })
  @ApiResponse({ status: 400, description: 'Transaction is not reconciled' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  unreconcile(@Request() req, @Param('id') id: string) {
    return this.transactionsService.unreconcile(req.user.id, id);
  }

  // ==================== Split Transaction Endpoints ====================

  @Get(':id/splits')
  @ApiOperation({ summary: 'Get all splits for a transaction' })
  @ApiParam({ name: 'id', description: 'Transaction UUID' })
  @ApiResponse({ status: 200, description: 'Splits retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  getSplits(@Request() req, @Param('id') id: string) {
    return this.transactionsService.getSplits(req.user.id, id);
  }

  @Put(':id/splits')
  @ApiOperation({ summary: 'Replace all splits for a transaction (atomic update)' })
  @ApiParam({ name: 'id', description: 'Transaction UUID' })
  @ApiResponse({ status: 200, description: 'Splits updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid splits data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  updateSplits(
    @Request() req,
    @Param('id') id: string,
    @Body() splits: CreateTransactionSplitDto[],
  ) {
    return this.transactionsService.updateSplits(req.user.id, id, splits);
  }

  @Post(':id/splits')
  @ApiOperation({ summary: 'Add a single split to a transaction' })
  @ApiParam({ name: 'id', description: 'Transaction UUID' })
  @ApiResponse({ status: 201, description: 'Split added successfully' })
  @ApiResponse({ status: 400, description: 'Invalid split data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  addSplit(
    @Request() req,
    @Param('id') id: string,
    @Body() splitDto: CreateTransactionSplitDto,
  ) {
    return this.transactionsService.addSplit(req.user.id, id, splitDto);
  }

  @Delete(':id/splits/:splitId')
  @ApiOperation({ summary: 'Remove a split from a transaction' })
  @ApiParam({ name: 'id', description: 'Transaction UUID' })
  @ApiParam({ name: 'splitId', description: 'Split UUID' })
  @ApiResponse({ status: 200, description: 'Split removed successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Transaction or split not found' })
  removeSplit(
    @Request() req,
    @Param('id') id: string,
    @Param('splitId') splitId: string,
  ) {
    return this.transactionsService.removeSplit(req.user.id, id, splitId);
  }

  // ==================== Transfer Endpoints ====================

  @Post('transfer')
  @ApiOperation({ summary: 'Create a transfer between two accounts' })
  @ApiResponse({ status: 201, description: 'Transfer created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - invalid transfer data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  createTransfer(@Request() req, @Body() createTransferDto: CreateTransferDto) {
    return this.transactionsService.createTransfer(req.user.id, createTransferDto);
  }

  @Get(':id/linked')
  @ApiOperation({ summary: 'Get the linked transaction for a transfer' })
  @ApiParam({ name: 'id', description: 'Transaction UUID' })
  @ApiResponse({ status: 200, description: 'Linked transaction retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  getLinkedTransaction(@Request() req, @Param('id') id: string) {
    return this.transactionsService.getLinkedTransaction(req.user.id, id);
  }

  @Delete(':id/transfer')
  @ApiOperation({ summary: 'Delete a transfer (deletes both linked transactions)' })
  @ApiParam({ name: 'id', description: 'Transaction UUID' })
  @ApiResponse({ status: 200, description: 'Transfer deleted successfully' })
  @ApiResponse({ status: 400, description: 'Transaction is not a transfer' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  removeTransfer(@Request() req, @Param('id') id: string) {
    return this.transactionsService.removeTransfer(req.user.id, id);
  }

  @Patch(':id/transfer')
  @ApiOperation({ summary: 'Update a transfer (updates both linked transactions)' })
  @ApiParam({ name: 'id', description: 'Transaction UUID' })
  @ApiResponse({ status: 200, description: 'Transfer updated successfully' })
  @ApiResponse({ status: 400, description: 'Transaction is not a transfer or invalid data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  updateTransfer(
    @Request() req,
    @Param('id') id: string,
    @Body() updateTransferDto: Partial<CreateTransferDto>,
  ) {
    return this.transactionsService.updateTransfer(req.user.id, id, updateTransferDto);
  }
}
