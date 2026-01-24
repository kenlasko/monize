import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  ParseBoolPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { SecuritiesService } from './securities.service';
import { CreateSecurityDto } from './dto/create-security.dto';
import { UpdateSecurityDto } from './dto/update-security.dto';
import { Security } from './entities/security.entity';

@ApiTags('securities')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('securities')
export class SecuritiesController {
  constructor(private readonly securitiesService: SecuritiesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new security' })
  @ApiResponse({ status: 201, description: 'Security created successfully', type: Security })
  @ApiResponse({ status: 409, description: 'Security with symbol already exists' })
  create(@Body() createSecurityDto: CreateSecurityDto): Promise<Security> {
    return this.securitiesService.create(createSecurityDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all securities' })
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'List of securities', type: [Security] })
  findAll(
    @Query('includeInactive', new DefaultValuePipe(false), ParseBoolPipe) includeInactive: boolean,
  ): Promise<Security[]> {
    return this.securitiesService.findAll(includeInactive);
  }

  @Get('search')
  @ApiOperation({ summary: 'Search securities by symbol or name' })
  @ApiQuery({ name: 'q', required: true, description: 'Search query' })
  @ApiResponse({ status: 200, description: 'Search results', type: [Security] })
  search(@Query('q') query: string): Promise<Security[]> {
    return this.securitiesService.search(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a security by ID' })
  @ApiResponse({ status: 200, description: 'Security details', type: Security })
  @ApiResponse({ status: 404, description: 'Security not found' })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Security> {
    return this.securitiesService.findOne(id);
  }

  @Get('symbol/:symbol')
  @ApiOperation({ summary: 'Get a security by symbol' })
  @ApiResponse({ status: 200, description: 'Security details', type: Security })
  @ApiResponse({ status: 404, description: 'Security not found' })
  findBySymbol(@Param('symbol') symbol: string): Promise<Security> {
    return this.securitiesService.findBySymbol(symbol);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a security' })
  @ApiResponse({ status: 200, description: 'Security updated successfully', type: Security })
  @ApiResponse({ status: 404, description: 'Security not found' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateSecurityDto: UpdateSecurityDto,
  ): Promise<Security> {
    return this.securitiesService.update(id, updateSecurityDto);
  }

  @Post(':id/deactivate')
  @ApiOperation({ summary: 'Deactivate a security' })
  @ApiResponse({ status: 200, description: 'Security deactivated', type: Security })
  deactivate(@Param('id', ParseUUIDPipe) id: string): Promise<Security> {
    return this.securitiesService.deactivate(id);
  }

  @Post(':id/activate')
  @ApiOperation({ summary: 'Activate a security' })
  @ApiResponse({ status: 200, description: 'Security activated', type: Security })
  activate(@Param('id', ParseUUIDPipe) id: string): Promise<Security> {
    return this.securitiesService.activate(id);
  }
}
