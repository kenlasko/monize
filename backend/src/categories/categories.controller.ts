import { ReportingEndpoint } from "../accruals/reporting-endpoint";
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
import { JointCategoriesService } from "./joint-categories.service";
import { CategoryDetailService } from "./category-detail.service";
import { CategoryDetailDto } from "./dto/category-detail.dto";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { UpdateCategoryDto } from "./dto/update-category.dto";
import { ReassignTransactionsDto } from "./dto/reassign-transactions.dto";
import { ImportDefaultsDto } from "./dto/import-defaults.dto";
import { DEFAULT_CATEGORY_COUNTRY_CODES } from "./country-category-additions";
import {
  AllowDelegate,
  DelegateRequiresCapability,
} from "../delegation/decorators/delegate-access.decorator";
import { DelegationService } from "../delegation/delegation.service";
import { delegateReadableAccountScope } from "../delegation/delegate-account-scope.util";

@ApiTags("Categories")
@Controller("categories")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class CategoriesController {
  constructor(
    private readonly categoriesService: CategoriesService,
    private readonly categoryDetailService: CategoryDetailService,
    private readonly jointCategories: JointCategoriesService,
    private readonly delegationService: DelegationService,
  ) {}

  @Post()
  @ApiOperation({ summary: "Create a new category" })
  @ApiResponse({ status: 201, description: "Category created successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @AllowDelegate()
  @DelegateRequiresCapability("categories", "create")
  create(@Request() req, @Body() createCategoryDto: CreateCategoryDto) {
    return this.categoriesService.create(req.user.id, createCategoryDto);
  }

  /**
   * Grantee-facing (own context, not @AllowDelegate): create a category on the
   * ledger of the owner who shares `accountId` jointly with the caller. A
   * joint row belongs to the owner and may only carry the owner's category
   * ids, so text typed into that register's picker has nowhere else to go --
   * `POST /categories` above writes to the caller's own ledger. Authorized by
   * the delegation's categories-can-create capability; see
   * JointCategoriesService for why the account gate is READ.
   */
  @Post("joint/:accountId")
  @ApiOperation({
    summary: "Create a category on the owner ledger of a joint account",
  })
  @ApiParam({ name: "accountId", description: "Joint account UUID" })
  @ApiResponse({ status: 201, description: "Category created successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - the owner has not granted category creation",
  })
  @ApiResponse({ status: 404, description: "Account not shared jointly" })
  createForJointAccount(
    @Request() req,
    @Param("accountId", ParseUUIDPipe) accountId: string,
    @Body() createCategoryDto: CreateCategoryDto,
  ) {
    return this.jointCategories.create(
      req.user.realUserId ?? req.user.id,
      accountId,
      createCategoryDto,
    );
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
  @AllowDelegate()
  findAll(
    @Request() req,
    @Query("includeSystem", new ParseBoolPipe({ optional: true }))
    includeSystem?: boolean,
  ) {
    return this.categoriesService.findAll(req.user.id, includeSystem || false);
  }

  @Get("tree")
  @AllowDelegate()
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
  @AllowDelegate()
  @ApiOperation({ summary: "Get category statistics" })
  @ApiResponse({
    status: 200,
    description: "Category statistics retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getStats(@Request() req) {
    return this.categoriesService.getStats(req.user.id);
  }

  @Get("default-countries")
  @AllowDelegate()
  @ApiOperation({
    summary: "List countries with a default-category overlay",
  })
  @ApiResponse({
    status: 200,
    description: "Supported country codes retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getDefaultCountries(): { countries: string[] } {
    return { countries: [...DEFAULT_CATEGORY_COUNTRY_CODES] };
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
  importDefaults(@Request() req, @Body() importDefaultsDto: ImportDefaultsDto) {
    return this.categoriesService.importDefaults(
      req.user.id,
      importDefaultsDto,
    );
  }

  @Get("income")
  @AllowDelegate()
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
  @AllowDelegate()
  @ApiOperation({ summary: "Get all expense categories" })
  @ApiResponse({
    status: 200,
    description: "Expense categories retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getExpenseCategories(@Request() req) {
    return this.categoriesService.findByType(req.user.id, false);
  }

  @ReportingEndpoint("cash")
  @Get(":id/detail")
  @AllowDelegate()
  @ApiOperation({ summary: "Get the category detail page aggregate" })
  @ApiParam({ name: "id", description: "Category UUID" })
  @ApiResponse({
    status: 200,
    description: "Category detail for the category detail page",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Category not found" })
  async getDetail(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<CategoryDetailDto> {
    // An acting delegate sees only the accounts they were granted READ on,
    // exactly as the register and the analytics endpoints scope them.
    const accountScope = await delegateReadableAccountScope(
      req,
      this.delegationService,
    );
    return this.categoryDetailService.getDetail(req.user.id, id, accountScope);
  }

  @Get(":id")
  @AllowDelegate()
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

  @Post(":id/impact-preview")
  @AllowDelegate()
  @DelegateRequiresCapability("categories", "edit")
  @ApiOperation({ summary: "Preview accrual impacts of a category update" })
  previewCategoryUpdate(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categoriesService.previewCategoryUpdate(req.user.id, id, dto);
  }

  @Post(":id/reassign-preview")
  @ApiOperation({ summary: "Preview accrual impacts of category reassignment" })
  previewCategoryReassignment(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ReassignTransactionsDto,
  ) {
    return this.categoriesService.previewCategoryReassignment(
      req.user.id,
      id,
      dto.toCategoryId ?? null,
    );
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
  @AllowDelegate()
  @DelegateRequiresCapability("categories", "edit")
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
  @AllowDelegate()
  @DelegateRequiresCapability("categories", "delete")
  remove(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.categoriesService.remove(req.user.id, id);
  }

  @Get(":id/transaction-count")
  @AllowDelegate()
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
    return reassignDto.accrualImpactFingerprint !== undefined
      ? this.categoriesService.reassignTransactions(
          req.user.id,
          id,
          reassignDto.toCategoryId ?? null,
          reassignDto.accrualImpactFingerprint,
        )
      : this.categoriesService.reassignTransactions(
          req.user.id,
          id,
          reassignDto.toCategoryId ?? null,
        );
  }
}
