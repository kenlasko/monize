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
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { CategoriesService } from "./categories.service";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { UpdateCategoryDto } from "./dto/update-category.dto";
import { ReassignTransactionsDto } from "./dto/reassign-transactions.dto";

@ApiTags("Categories")
@Controller("categories")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Post()
  @ApiOperation({ summary: "Create a new category" })
  @ApiResponse({ status: 201, description: "Category created successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  create(@Request() req, @Body() createCategoryDto: CreateCategoryDto) {
    return this.categoriesService.create(req.user.id, createCategoryDto);
  }

  @Get()
  @ApiOperation({ summary: "Get all categories for the authenticated user" })
  @ApiQuery({
    name: "includeSystem",
    required: false,
    type: Boolean,
    description: "Include system categories",
  })
  @ApiResponse({
    status: 200,
    description: "List of categories retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  findAll(
    @Request() req,
    @Query("includeSystem", new ParseBoolPipe({ optional: true }))
    includeSystem?: boolean,
  ) {
    return this.categoriesService.findAll(req.user.id, includeSystem || false);
  }

  @Get("tree")
  @ApiOperation({ summary: "Get categories in tree structure (hierarchical)" })
  @ApiResponse({
    status: 200,
    description: "Category tree retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getTree(@Request() req) {
    return this.categoriesService.getTree(req.user.id);
  }

  @Get("stats")
  @ApiOperation({ summary: "Get category statistics" })
  @ApiResponse({
    status: 200,
    description: "Category statistics retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getStats(@Request() req) {
    return this.categoriesService.getStats(req.user.id);
  }

  @Post("import-defaults")
  @ApiOperation({ summary: "Import default categories for new users" })
  @ApiResponse({
    status: 201,
    description: "Default categories imported successfully",
  })
  @ApiResponse({
    status: 400,
    description: "User already has categories",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  importDefaults(@Request() req) {
    return this.categoriesService.importDefaults(req.user.id);
  }

  @Get("income")
  @ApiOperation({ summary: "Get all income categories" })
  @ApiResponse({
    status: 200,
    description: "Income categories retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getIncomeCategories(@Request() req) {
    return this.categoriesService.findByType(req.user.id, true);
  }

  @Get("expense")
  @ApiOperation({ summary: "Get all expense categories" })
  @ApiResponse({
    status: 200,
    description: "Expense categories retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getExpenseCategories(@Request() req) {
    return this.categoriesService.findByType(req.user.id, false);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a specific category by ID" })
  @ApiParam({ name: "id", description: "Category UUID" })
  @ApiResponse({
    status: 200,
    description: "Category retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - category does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Category not found" })
  findOne(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.categoriesService.findOne(req.user.id, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a category" })
  @ApiParam({ name: "id", description: "Category UUID" })
  @ApiResponse({
    status: 200,
    description: "Category updated successfully",
  })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - category does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Category not found" })
  update(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateCategoryDto: UpdateCategoryDto,
  ) {
    return this.categoriesService.update(req.user.id, id, updateCategoryDto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a category" })
  @ApiParam({ name: "id", description: "Category UUID" })
  @ApiResponse({ status: 200, description: "Category deleted successfully" })
  @ApiResponse({
    status: 400,
    description: "Cannot delete category with subcategories",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - category does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Category not found" })
  remove(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.categoriesService.remove(req.user.id, id);
  }

  @Get(":id/transaction-count")
  @ApiOperation({ summary: "Get the count of transactions using a category" })
  @ApiParam({ name: "id", description: "Category UUID" })
  @ApiResponse({
    status: 200,
    description: "Transaction count retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Category not found" })
  getTransactionCount(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.categoriesService.getTransactionCount(req.user.id, id);
  }

  @Post(":id/reassign")
  @ApiOperation({
    summary: "Reassign transactions from this category to another",
  })
  @ApiParam({ name: "id", description: "Source category UUID" })
  @ApiResponse({
    status: 200,
    description: "Transactions reassigned successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Category not found" })
  reassignTransactions(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() reassignDto: ReassignTransactionsDto,
  ) {
    return this.categoriesService.reassignTransactions(
      req.user.id,
      id,
      reassignDto.toCategoryId ?? null,
    );
  }
}
