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
  ParseBoolPipe,
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
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

@ApiTags('Accounts')
@Controller('accounts')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new account' })
  @ApiResponse({
    status: 201,
    description: 'Account created successfully',
  })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  create(@Request() req, @Body() createAccountDto: CreateAccountDto) {
    return this.accountsService.create(req.user.id, createAccountDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all accounts for the authenticated user' })
  @ApiQuery({
    name: 'includeInactive',
    required: false,
    type: Boolean,
    description: 'Include closed accounts in the results',
  })
  @ApiResponse({
    status: 200,
    description: 'List of accounts retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  findAll(
    @Request() req,
    @Query('includeInactive', new ParseBoolPipe({ optional: true }))
    includeInactive?: boolean,
  ) {
    return this.accountsService.findAll(req.user.id, includeInactive || false);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Get account summary statistics' })
  @ApiResponse({
    status: 200,
    description: 'Account summary retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getSummary(@Request() req) {
    return this.accountsService.getSummary(req.user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific account by ID' })
  @ApiParam({
    name: 'id',
    description: 'Account UUID',
  })
  @ApiResponse({
    status: 200,
    description: 'Account retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - account does not belong to user' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  findOne(@Request() req, @Param('id') id: string) {
    return this.accountsService.findOne(req.user.id, id);
  }

  @Get(':id/balance')
  @ApiOperation({ summary: 'Get the current balance of an account' })
  @ApiParam({
    name: 'id',
    description: 'Account UUID',
  })
  @ApiResponse({
    status: 200,
    description: 'Account balance retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - account does not belong to user' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  getBalance(@Request() req, @Param('id') id: string) {
    return this.accountsService.getBalance(req.user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an account' })
  @ApiParam({
    name: 'id',
    description: 'Account UUID',
  })
  @ApiResponse({
    status: 200,
    description: 'Account updated successfully',
  })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - account does not belong to user' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  update(
    @Request() req,
    @Param('id') id: string,
    @Body() updateAccountDto: UpdateAccountDto,
  ) {
    return this.accountsService.update(req.user.id, id, updateAccountDto);
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Close an account (soft delete)' })
  @ApiParam({
    name: 'id',
    description: 'Account UUID',
  })
  @ApiResponse({
    status: 200,
    description: 'Account closed successfully',
  })
  @ApiResponse({ status: 400, description: 'Bad request - account has non-zero balance' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - account does not belong to user' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  close(@Request() req, @Param('id') id: string) {
    return this.accountsService.close(req.user.id, id);
  }

  @Post(':id/reopen')
  @ApiOperation({ summary: 'Reopen a closed account' })
  @ApiParam({
    name: 'id',
    description: 'Account UUID',
  })
  @ApiResponse({
    status: 200,
    description: 'Account reopened successfully',
  })
  @ApiResponse({ status: 400, description: 'Bad request - account is not closed' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - account does not belong to user' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  reopen(@Request() req, @Param('id') id: string) {
    return this.accountsService.reopen(req.user.id, id);
  }
}
