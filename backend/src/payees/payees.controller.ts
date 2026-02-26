import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
  ParseIntPipe,
  DefaultValuePipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { PayeesService } from "./payees.service";
import { CreatePayeeDto } from "./dto/create-payee.dto";
import { UpdatePayeeDto } from "./dto/update-payee.dto";
import { ApplyCategorySuggestionsDto } from "./dto/apply-category-suggestions.dto";
import { Payee } from "./entities/payee.entity";

@ApiTags("payees")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("payees")
export class PayeesController {
  constructor(private readonly payeesService: PayeesService) {}

  @Post()
  @ApiOperation({ summary: "Create a new payee" })
  @ApiResponse({
    status: 201,
    description: "Payee created successfully",
    type: Payee,
  })
  @ApiResponse({ status: 409, description: "Payee with name already exists" })
  create(
    @Request() req,
    @Body() createPayeeDto: CreatePayeeDto,
  ): Promise<Payee> {
    return this.payeesService.create(req.user.id, createPayeeDto);
  }

  @Get()
  @ApiOperation({ summary: "Get all payees for the authenticated user" })
  @ApiResponse({ status: 200, description: "List of payees", type: [Payee] })
  findAll(@Request() req): Promise<Payee[]> {
    return this.payeesService.findAll(req.user.id);
  }

  @Get("search")
  @ApiOperation({ summary: "Search payees by name" })
  @ApiQuery({ name: "q", required: true, description: "Search query" })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    description: "Maximum results (default: 10)",
  })
  @ApiResponse({ status: 200, description: "Search results", type: [Payee] })
  search(
    @Request() req,
    @Query("q") query: string,
    @Query("limit", new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ): Promise<Payee[]> {
    const safeQuery = query ? query.slice(0, 200) : "";
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    return this.payeesService.search(req.user.id, safeQuery, safeLimit);
  }

  @Get("autocomplete")
  @ApiOperation({ summary: "Autocomplete payees (for input suggestions)" })
  @ApiQuery({
    name: "q",
    required: true,
    description: "Query string (payees starting with this)",
  })
  @ApiResponse({
    status: 200,
    description: "Autocomplete suggestions",
    type: [Payee],
  })
  autocomplete(@Request() req, @Query("q") query: string): Promise<Payee[]> {
    const safeQuery = query ? query.slice(0, 200) : "";
    return this.payeesService.autocomplete(req.user.id, safeQuery);
  }

  @Get("most-used")
  @ApiOperation({ summary: "Get most frequently used payees" })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    description: "Maximum results (default: 10)",
  })
  @ApiResponse({ status: 200, description: "Most used payees", type: [Payee] })
  getMostUsed(
    @Request() req,
    @Query("limit", new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ): Promise<Payee[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    return this.payeesService.getMostUsed(req.user.id, safeLimit);
  }

  @Get("recently-used")
  @ApiOperation({ summary: "Get recently used payees" })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    description: "Maximum results (default: 10)",
  })
  @ApiResponse({
    status: 200,
    description: "Recently used payees",
    type: [Payee],
  })
  getRecentlyUsed(
    @Request() req,
    @Query("limit", new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ): Promise<Payee[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    return this.payeesService.getRecentlyUsed(req.user.id, safeLimit);
  }

  @Get("summary")
  @ApiOperation({ summary: "Get payee statistics summary" })
  @ApiResponse({ status: 200, description: "Payee summary statistics" })
  getSummary(@Request() req) {
    return this.payeesService.getSummary(req.user.id);
  }

  @Get("category-suggestions/preview")
  @ApiOperation({
    summary:
      "Preview category auto-assignment suggestions based on transaction history",
  })
  @ApiQuery({
    name: "minTransactions",
    required: false,
    type: Number,
    description: "Minimum transactions (default: 5)",
  })
  @ApiQuery({
    name: "minPercentage",
    required: false,
    type: Number,
    description: "Minimum percentage (default: 75)",
  })
  @ApiQuery({
    name: "onlyWithoutCategory",
    required: false,
    type: Boolean,
    description: "Only payees without category (default: true)",
  })
  @ApiResponse({
    status: 200,
    description: "List of suggested category assignments",
  })
  getCategorySuggestions(
    @Request() req,
    @Query("minTransactions", new DefaultValuePipe(5), ParseIntPipe)
    minTransactions: number,
    @Query("minPercentage", new DefaultValuePipe(75), ParseIntPipe)
    minPercentage: number,
    @Query("onlyWithoutCategory", new DefaultValuePipe("true"))
    onlyWithoutCategory: string,
  ) {
    return this.payeesService.calculateCategorySuggestions(
      req.user.id,
      minTransactions,
      minPercentage,
      onlyWithoutCategory === "true",
    );
  }

  @Post("category-suggestions/apply")
  @ApiOperation({ summary: "Apply category auto-assignments to payees" })
  @ApiResponse({ status: 200, description: "Assignments applied successfully" })
  applyCategorySuggestions(
    @Request() req,
    @Body() dto: ApplyCategorySuggestionsDto,
  ) {
    return this.payeesService.applyCategorySuggestions(
      req.user.id,
      dto.assignments,
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a payee by ID" })
  @ApiResponse({ status: 200, description: "Payee details", type: Payee })
  @ApiResponse({ status: 404, description: "Payee not found" })
  findOne(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<Payee> {
    return this.payeesService.findOne(req.user.id, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a payee" })
  @ApiResponse({
    status: 200,
    description: "Payee updated successfully",
    type: Payee,
  })
  @ApiResponse({ status: 404, description: "Payee not found" })
  @ApiResponse({ status: 409, description: "Payee with name already exists" })
  update(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updatePayeeDto: UpdatePayeeDto,
  ): Promise<Payee> {
    return this.payeesService.update(req.user.id, id, updatePayeeDto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a payee" })
  @ApiResponse({ status: 200, description: "Payee deleted successfully" })
  @ApiResponse({ status: 404, description: "Payee not found" })
  remove(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.payeesService.remove(req.user.id, id);
  }
}
