import { ReportingEndpoint } from "../accruals/reporting-endpoint";
import { RemovePayeeDto } from "./dto/remove-payee.dto";
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
  Res,
  ParseUUIDPipe,
  ParseIntPipe,
  ParseFloatPipe,
  ParseBoolPipe,
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
import { Throttle } from "@nestjs/throttler";
import { Response } from "express";
import { assertStringParam } from "../common/query-param-utils";
import { PayeesService } from "./payees.service";
import { PayeeDetailService } from "./payee-detail.service";
import { PayeeDetailDto } from "./dto/payee-detail.dto";
import {
  PayeeAutoMergeService,
  CategoryMatchMode,
} from "./payee-auto-merge.service";
import { CreatePayeeDto } from "./dto/create-payee.dto";
import { UpdatePayeeDto } from "./dto/update-payee.dto";
import { CreatePayeeAliasDto } from "./dto/create-payee-alias.dto";
import { MergePayeeDto } from "./dto/merge-payee.dto";
import {
  ApplyAutoMergeDto,
  AutoMergeGroupDto,
} from "./dto/apply-auto-merge.dto";
import { ApplyCategorySuggestionsDto } from "./dto/apply-category-suggestions.dto";
import { DeactivatePayeesDto } from "./dto/deactivate-payees.dto";
import { LookupPayeeContactDto } from "./dto/lookup-payee-contact.dto";
import { PayeeContactLookupService } from "./lookup/payee-contact-lookup.service";
import { buildLookupContext } from "./lookup/lookup-context";
import { PayeeContactEnrichmentService } from "./lookup/payee-contact-enrichment.service";
import { ContactLookupOutcome } from "./lookup/payee-contact-lookup.types";
import { Payee } from "./entities/payee.entity";
import { PayeeAlias } from "./entities/payee-alias.entity";
import {
  AllowDelegate,
  DelegateRequiresCapability,
} from "../delegation/decorators/delegate-access.decorator";
import { DelegationService } from "../delegation/delegation.service";
import { delegateReadableAccountScope } from "../delegation/delegate-account-scope.util";

@ApiTags("Payees")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("payees")
export class PayeesController {
  constructor(
    private readonly payeesService: PayeesService,
    private readonly payeeDetailService: PayeeDetailService,
    private readonly payeeAutoMergeService: PayeeAutoMergeService,
    private readonly contactLookupService: PayeeContactLookupService,
    private readonly contactEnrichmentService: PayeeContactEnrichmentService,
    private readonly delegationService: DelegationService,
  ) {}

  @Post()
  @ApiOperation({ summary: "Create a new payee" })
  @ApiResponse({
    status: 201,
    description: "Payee created successfully",
    type: Payee,
  })
  @ApiResponse({ status: 409, description: "Payee with name already exists" })
  @AllowDelegate()
  @DelegateRequiresCapability("payees", "create")
  create(
    @Request() req,
    @Body() createPayeeDto: CreatePayeeDto,
  ): Promise<Payee> {
    // `deferContactLookup` says what the caller will do, not what the payee
    // is, so it travels as an option and never reaches the row: spreading it
    // into the entity would put a non-column onto the insert.
    const { deferContactLookup, ...dto } = createPayeeDto;
    return this.payeesService.create(req.user.id, dto, { deferContactLookup });
  }

  @Get()
  @ApiOperation({ summary: "Get all payees for the authenticated user" })
  @ApiQuery({
    name: "status",
    required: false,
    enum: ["active", "inactive", "all"],
    description: "Filter by active status (default: all)",
  })
  @ApiResponse({ status: 200, description: "List of payees", type: [Payee] })
  @AllowDelegate()
  findAll(
    @Request() req,
    @Query("status") status?: "active" | "inactive" | "all",
  ): Promise<Payee[]> {
    return this.payeesService.findAll(req.user.id, status);
  }

  @Get("search")
  @AllowDelegate()
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
    const q = assertStringParam(query, "q");
    const safeQuery = q ? q.slice(0, 200) : "";
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    return this.payeesService.search(req.user.id, safeQuery, safeLimit);
  }

  @Get("autocomplete")
  @AllowDelegate()
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
    const q = assertStringParam(query, "q");
    const safeQuery = q ? q.slice(0, 200) : "";
    return this.payeesService.autocomplete(req.user.id, safeQuery);
  }

  @Get("most-used")
  @AllowDelegate()
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
  @AllowDelegate()
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
  @AllowDelegate()
  @ApiOperation({ summary: "Get payee statistics summary" })
  @ApiResponse({ status: 200, description: "Payee summary statistics" })
  getSummary(@Request() req) {
    return this.payeesService.getSummary(req.user.id);
  }

  @Get("aliases")
  @AllowDelegate()
  @ApiOperation({ summary: "Get all aliases for the user" })
  @ApiResponse({
    status: 200,
    description: "List of all aliases",
    type: [PayeeAlias],
  })
  getAllAliases(@Request() req): Promise<PayeeAlias[]> {
    return this.payeesService.getAllAliases(req.user.id);
  }

  @Post("aliases")
  @ApiOperation({ summary: "Create a new payee alias" })
  @ApiResponse({
    status: 201,
    description: "Alias created successfully",
    type: PayeeAlias,
  })
  @ApiResponse({
    status: 409,
    description: "Alias conflicts with existing alias",
  })
  createAlias(
    @Request() req,
    @Body() dto: CreatePayeeAliasDto,
  ): Promise<PayeeAlias> {
    return this.payeesService.createAlias(req.user.id, dto);
  }

  @Delete("aliases/:aliasId")
  @ApiOperation({ summary: "Delete a payee alias" })
  @ApiResponse({ status: 200, description: "Alias deleted successfully" })
  @ApiResponse({ status: 404, description: "Alias not found" })
  removeAlias(
    @Request() req,
    @Param("aliasId", ParseUUIDPipe) aliasId: string,
  ): Promise<void> {
    return this.payeesService.removeAlias(req.user.id, aliasId);
  }

  @Post("merge")
  @ApiOperation({
    summary:
      "Merge one payee into another (reassign transactions, optionally add alias, delete source)",
  })
  @ApiResponse({ status: 200, description: "Payees merged successfully" })
  @ApiResponse({ status: 404, description: "Payee not found" })
  mergePayees(@Request() req, @Body() dto: MergePayeeDto) {
    return this.payeesService.mergePayees(req.user.id, dto);
  }

  /**
   * Look a name up without persisting anything -- the New Payee form's
   * prefill and the edit form's "Look up" button. Always 200: the feature
   * being off, no provider being configured and a failed lookup are states
   * the form has to explain differently, not errors, and a 4xx would reach
   * the user as a toast about a request they did not knowingly make. The
   * client must read `reason` and never show "nothing found" for a failure.
   *
   * Declared before the `:id` routes on purpose; a literal segment after a
   * parameter route is shadowed by it.
   */
  @Post("lookup-contact")
  @AllowDelegate()
  @DelegateRequiresCapability("payees", "create")
  // Each call may be a paid model call on the user's provider.
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary:
      "Look up a payee's website, address, email and phone by name, without saving",
  })
  @ApiResponse({
    status: 200,
    description:
      "{ suggestion, reason } -- suggestion is null unless reason is 'ok'",
  })
  lookupContact(
    @Request() req,
    @Body() dto: LookupPayeeContactDto,
  ): Promise<ContactLookupOutcome> {
    return this.contactLookupService.lookup(
      req.user.id,
      // Whatever the form already holds goes in as context, so the answer is
      // about this organisation in this place. None of it is stored here.
      { name: dto.name, known: buildLookupContext(dto) },
      // The button is the consent: this is a lookup the user asked for by
      // name, whether or not they enabled the automatic one.
      { ignorePreference: true },
    );
  }

  @Get("auto-merge/preview")
  @ApiOperation({
    summary:
      "Preview auto-merge groups of near-duplicate payees (token + fuzzy clustering)",
  })
  @ApiQuery({
    name: "minGroupSize",
    required: false,
    type: Number,
    description: "Minimum payees per merge group (default: 2)",
  })
  @ApiQuery({
    name: "similarityThreshold",
    required: false,
    type: Number,
    description: "Fuzzy similarity threshold 0.5-1 (default: 0.85)",
  })
  @ApiQuery({
    name: "minTokenLength",
    required: false,
    type: Number,
    description: "Minimum significant token length (default: 3)",
  })
  @ApiQuery({
    name: "includeInactive",
    required: false,
    type: Boolean,
    description: "Include inactive payees (default: false)",
  })
  @ApiQuery({
    name: "categoryMatch",
    required: false,
    enum: ["off", "category", "subcategory"],
    description:
      "Only merge payees sharing a category/subcategory (default: off)",
  })
  @ApiQuery({
    name: "ignoreCommonWords",
    required: false,
    type: Boolean,
    description: "Exclude payees anchored on a common word (default: false)",
  })
  @ApiQuery({
    name: "commonWordMinVariants",
    required: false,
    type: Number,
    description: "Auto-detect threshold for common leading words (default: 5)",
  })
  @ApiResponse({ status: 200, description: "Suggested merge groups" })
  previewAutoMerge(
    @Request() req,
    @Query("minGroupSize", new DefaultValuePipe(2), ParseIntPipe)
    minGroupSize: number,
    @Query("similarityThreshold", new DefaultValuePipe(0.85), ParseFloatPipe)
    similarityThreshold: number,
    @Query("minTokenLength", new DefaultValuePipe(3), ParseIntPipe)
    minTokenLength: number,
    @Query("includeInactive", new DefaultValuePipe(false), ParseBoolPipe)
    includeInactive: boolean,
    @Query("categoryMatch", new DefaultValuePipe("off"))
    categoryMatch: string,
    @Query("ignoreCommonWords", new DefaultValuePipe(false), ParseBoolPipe)
    ignoreCommonWords: boolean,
    @Query("commonWordMinVariants", new DefaultValuePipe(5), ParseIntPipe)
    commonWordMinVariants: number,
  ) {
    const categoryMatchMode: CategoryMatchMode =
      categoryMatch === "category" || categoryMatch === "subcategory"
        ? categoryMatch
        : "off";
    return this.payeeAutoMergeService.previewAutoMerge(req.user.id, {
      minGroupSize: Math.min(Math.max(minGroupSize, 2), 50),
      similarityThreshold: Math.min(Math.max(similarityThreshold, 0.5), 1),
      minTokenLength: Math.min(Math.max(minTokenLength, 2), 10),
      includeInactive,
      categoryMatch: categoryMatchMode,
      ignoreCommonWords,
      commonWordMinVariants: Math.min(Math.max(commonWordMinVariants, 2), 50),
    });
  }

  @Post("auto-merge/category-impact-preview")
  @ApiOperation({
    summary: "Preview category backfill impacts for one auto-merge group",
  })
  previewAutoMergeCategoryImpact(
    @Request() req,
    @Body() dto: AutoMergeGroupDto,
  ) {
    return this.payeeAutoMergeService.previewCategoryImpact(req.user.id, dto);
  }

  @Post("auto-merge/apply")
  @ApiOperation({
    summary:
      "Apply auto-merge groups: merge each group into its canonical payee and create wildcard aliases",
  })
  @ApiResponse({ status: 201, description: "Auto-merge applied successfully" })
  applyAutoMerge(@Request() req, @Body() dto: ApplyAutoMergeDto) {
    return this.payeeAutoMergeService.applyAutoMerge(req.user.id, dto.groups);
  }

  @Get("category-suggestions/preview")
  @AllowDelegate()
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
    @Query("onlyWithoutCategory", new DefaultValuePipe(true), ParseBoolPipe)
    onlyWithoutCategory: boolean,
  ) {
    return this.payeesService.calculateCategorySuggestions(
      req.user.id,
      minTransactions,
      minPercentage,
      onlyWithoutCategory,
    );
  }

  @Post("category-suggestions/category-impact-preview")
  @ApiOperation({
    summary: "Preview accrual impacts of category suggestion backfills",
  })
  previewCategorySuggestionsImpact(
    @Request() req,
    @Body() dto: ApplyCategorySuggestionsDto,
  ) {
    return this.payeesService.previewCategorySuggestionsImpact(
      req.user.id,
      dto.assignments,
    );
  }

  @Post("category-suggestions/apply")
  @ApiOperation({ summary: "Apply category auto-assignments to payees" })
  @ApiResponse({ status: 200, description: "Assignments applied successfully" })
  applyCategorySuggestions(
    @Request() req,
    @Body() dto: ApplyCategorySuggestionsDto,
  ) {
    return dto.accrualImpactFingerprint !== undefined
      ? this.payeesService.applyCategorySuggestions(
          req.user.id,
          dto.assignments,
          dto.accrualImpactFingerprint,
        )
      : this.payeesService.applyCategorySuggestions(
          req.user.id,
          dto.assignments,
        );
  }

  @Get("deactivation/preview")
  @AllowDelegate()
  @ApiOperation({
    summary: "Preview which payees would be deactivated based on criteria",
  })
  @ApiQuery({
    name: "maxTransactions",
    required: false,
    type: Number,
    description: "Maximum transaction count threshold (default: 3)",
  })
  @ApiQuery({
    name: "monthsUnused",
    required: false,
    type: Number,
    description: "Months since last use (default: 12)",
  })
  @ApiResponse({
    status: 200,
    description: "List of payees that match deactivation criteria",
  })
  previewDeactivation(
    @Request() req,
    @Query("maxTransactions", new DefaultValuePipe(3), ParseIntPipe)
    maxTransactions: number,
    @Query("monthsUnused", new DefaultValuePipe(12), ParseIntPipe)
    monthsUnused: number,
  ) {
    const safeMaxTransactions = Math.min(Math.max(maxTransactions, 0), 1000);
    const safeMonthsUnused = Math.min(Math.max(monthsUnused, 1), 120);
    return this.payeesService.previewDeactivation(
      req.user.id,
      safeMaxTransactions,
      safeMonthsUnused,
    );
  }

  @Post("deactivation/apply")
  @ApiOperation({ summary: "Bulk deactivate payees" })
  @ApiResponse({
    status: 200,
    description: "Payees deactivated successfully",
  })
  deactivatePayees(@Request() req, @Body() dto: DeactivatePayeesDto) {
    return this.payeesService.deactivatePayees(req.user.id, dto.payeeIds);
  }

  @Post(":id/reactivate")
  @ApiOperation({ summary: "Reactivate a deactivated payee" })
  @ApiResponse({
    status: 200,
    description: "Payee reactivated successfully",
    type: Payee,
  })
  @ApiResponse({ status: 404, description: "Payee not found" })
  reactivatePayee(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<Payee> {
    return this.payeesService.reactivatePayee(req.user.id, id);
  }

  @Get(":id/aliases")
  @AllowDelegate()
  @ApiOperation({ summary: "Get all aliases for a specific payee" })
  @ApiResponse({
    status: 200,
    description: "List of aliases for the payee",
    type: [PayeeAlias],
  })
  @ApiResponse({ status: 404, description: "Payee not found" })
  getAliases(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<PayeeAlias[]> {
    return this.payeesService.getAliases(req.user.id, id);
  }

  @ReportingEndpoint("cash")
  @Get(":id/detail")
  @AllowDelegate()
  @ApiOperation({ summary: "Get the payee detail page aggregate" })
  @ApiResponse({
    status: 200,
    description: "Payee detail for the payee detail page",
  })
  @ApiResponse({ status: 404, description: "Payee not found" })
  async getDetail(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<PayeeDetailDto> {
    // An acting delegate sees only the accounts they were granted READ on,
    // exactly as the register and the analytics endpoints scope them.
    const accountScope = await delegateReadableAccountScope(
      req,
      this.delegationService,
    );
    return this.payeeDetailService.getDetail(req.user.id, id, accountScope);
  }

  @Get(":id/logo")
  @AllowDelegate()
  @ApiOperation({ summary: "Stream the cached brand favicon for a payee" })
  @ApiResponse({ status: 200, description: "Logo image bytes" })
  @ApiResponse({ status: 404, description: "Payee or logo not found" })
  async getLogo(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { data, contentType } = await this.payeesService.getLogo(
      req.user.id,
      id,
    );
    res.set({
      "Content-Type": contentType,
      "Content-Length": String(data.length),
      // Per-user cached image; safe to cache in the browser for a day.
      "Cache-Control": "private, max-age=86400",
    });
    res.end(data);
  }

  @Post(":id/refresh-logo")
  @AllowDelegate()
  @DelegateRequiresCapability("payees", "edit")
  @ApiOperation({ summary: "Re-fetch the payee's brand favicon" })
  @ApiResponse({ status: 200, description: "Payee with refreshed logo state" })
  @ApiResponse({ status: 404, description: "Payee not found" })
  refreshLogo(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<Payee> {
    return this.payeesService.refreshLogo(req.user.id, id);
  }

  /**
   * Look an existing payee up and propose what could change, writing nothing.
   *
   * The detail screen shows the answer in a confirmation dialogue -- with a
   * picker when the name means more than one organisation or branch -- and
   * the user's confirmation goes through `PATCH /payees/:id`, as their own
   * edit. That is what lets a confirmed value replace a stored one while the
   * lookup itself never may (INV-PAYEE-001).
   *
   * Always 200 for a payee the caller owns: the feature being off, no
   * provider and a failed lookup are states the dialogue explains
   * differently, not errors.
   */
  @Post(":id/lookup-contact")
  @AllowDelegate()
  @DelegateRequiresCapability("payees", "edit")
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary:
      "Look up a payee's contact details and return the candidates, without saving",
  })
  @ApiResponse({
    status: 200,
    description:
      "{ suggestions, reason } -- suggestions is empty unless reason is 'ok', and carries more than one entry only when the name matches more than one organisation or branch",
  })
  @ApiResponse({ status: 404, description: "Payee not found" })
  lookupContactForPayee(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<ContactLookupOutcome> {
    return this.payeesService.lookupContactForPayee(req.user.id, id);
  }

  @Get("inactive/match")
  @AllowDelegate()
  @ApiOperation({
    summary: "Check if a payee name matches an inactive payee",
  })
  @ApiQuery({
    name: "name",
    required: true,
    description: "Payee name to check",
  })
  @ApiResponse({
    status: 200,
    description: "Matching inactive payee or null",
  })
  findInactiveByName(@Request() req, @Query("name") name: string) {
    const n = assertStringParam(name, "name");
    const safeName = n ? n.slice(0, 255) : "";
    return this.payeesService.findInactiveByName(req.user.id, safeName);
  }

  @Get(":id")
  @AllowDelegate()
  @ApiOperation({ summary: "Get a payee by ID" })
  @ApiResponse({ status: 200, description: "Payee details", type: Payee })
  @ApiResponse({ status: 404, description: "Payee not found" })
  findOne(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<Payee> {
    return this.payeesService.findOne(req.user.id, id);
  }

  @Post(":id/category-impact-preview")
  @ApiOperation({
    summary: "Preview accrual impacts of applying a payee category",
  })
  @AllowDelegate()
  @DelegateRequiresCapability("payees", "edit")
  previewCategoryImpact(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdatePayeeDto,
  ) {
    return this.payeesService.previewCategoryImpact(req.user.id, id, dto);
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
  @AllowDelegate()
  @DelegateRequiresCapability("payees", "edit")
  update(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updatePayeeDto: UpdatePayeeDto,
  ): Promise<Payee> {
    return this.payeesService.update(req.user.id, id, updatePayeeDto);
  }

  @Post(":id/remove-preview")
  @AllowDelegate()
  @DelegateRequiresCapability("payees", "delete")
  @ApiOperation({ summary: "Preview accrual impacts of deleting a payee" })
  previewRemoval(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.payeesService.previewRemoval(req.user.id, id);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a payee" })
  @ApiResponse({ status: 200, description: "Payee deleted successfully" })
  @ApiResponse({ status: 404, description: "Payee not found" })
  @AllowDelegate()
  @DelegateRequiresCapability("payees", "delete")
  remove(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RemovePayeeDto = {},
  ): Promise<void> {
    return dto.accrualImpactFingerprint !== undefined
      ? this.payeesService.remove(req.user.id, id, dto.accrualImpactFingerprint)
      : this.payeesService.remove(req.user.id, id);
  }
}
