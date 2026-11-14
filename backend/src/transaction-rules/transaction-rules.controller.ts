import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { OwnerOnly } from "../delegation/decorators/delegate-access.decorator";
import { TransactionRulesService } from "./transaction-rules.service";
import { TransactionRulesRunService } from "./transaction-rules-run.service";
import { TransactionRulesMatchService } from "./transaction-rules-match.service";
import { ExplainRuleRowDto } from "./dto/explain-rule-row.dto";
import {
  MatchDraftRuleDto,
  PreviewDraftRuleDto,
  RuleRunFiltersDto,
  RunTransactionRuleDto,
} from "./dto/rule-run.dto";
import { DEFAULT_RULE_APPLICATIONS_LIMIT } from "./transaction-rules.limits";
import { CreateTransactionRuleDto } from "./dto/create-transaction-rule.dto";
import { UpdateTransactionRuleDto } from "./dto/update-transaction-rule.dto";
import { ReorderTransactionRulesDto } from "./dto/reorder-transaction-rules.dto";
import { SetTransactionRuleEnabledDto } from "./dto/set-transaction-rule-enabled.dto";
import { TransactionRuleResponseDto } from "./dto/transaction-rule-response.dto";
import { AllowPat, PatScope } from "../auth/pat-access/pat-access.decorator";

/**
 * A user's own rules. Owner-only: `@OwnerOnly()` makes `AccountDelegateGuard`
 * refuse a delegate ("acting as") session on every route here, which is the
 * fail-closed default made explicit (design section 3, decision 8). `userId`
 * is the JWT's, never a param or a body field.
 */
@ApiTags("Transaction Rules")
@AllowPat()
@Controller("transaction-rules")
@UseGuards(AuthGuard("jwt"))
@OwnerOnly()
@ApiBearerAuth()
export class TransactionRulesController {
  constructor(
    private readonly rulesService: TransactionRulesService,
    private readonly runService: TransactionRulesRunService,
    private readonly matchService: TransactionRulesMatchService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List my rules in evaluation order" })
  @ApiResponse({ status: 200, type: [TransactionRuleResponseDto] })
  findAll(@Request() req: { user: { id: string } }) {
    return this.rulesService.list(req.user.id);
  }

  @Post()
  @ApiOperation({ summary: "Create a rule at the end of the list" })
  @ApiResponse({ status: 201, type: TransactionRuleResponseDto })
  @ApiResponse({ status: 400, description: "Invalid definition or limit hit" })
  create(
    @Request() req: { user: { id: string } },
    @Body() dto: CreateTransactionRuleDto,
  ) {
    return this.rulesService.create(req.user.id, dto);
  }

  // Registered before `:id` so the literal "reorder" segment is not captured
  // by ParseUUIDPipe.
  @Put("reorder")
  @ApiOperation({ summary: "Set the evaluation order of all my rules" })
  @ApiResponse({ status: 200, type: [TransactionRuleResponseDto] })
  @ApiResponse({ status: 409, description: "The list of rules changed" })
  reorder(
    @Request() req: { user: { id: string } },
    @Body() dto: ReorderTransactionRulesDto,
  ) {
    return this.rulesService.reorder(req.user.id, dto.ids);
  }

  // Registered before the `:id` routes, like "reorder": a literal segment
  // must not be captured by ParseUUIDPipe.
  @Post("preview-draft")
  @PatScope("read")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Test an unsaved rule on existing transactions (writes nothing)",
  })
  @ApiResponse({
    status: 200,
    description: "Planned changes and a fingerprint",
  })
  @ApiResponse({ status: 400, description: "Invalid definition" })
  previewDraft(
    @Request() req: { user: { id: string } },
    @Body() dto: PreviewDraftRuleDto,
  ) {
    return this.runService.previewDraft(req.user.id, dto);
  }

  // Registered before the `:id` routes, like "preview-draft". Read-only.
  @Post("match-draft")
  @PatScope("read")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Which existing transactions an unsaved condition matches, a page at a time (writes nothing)",
  })
  @ApiResponse({
    status: 200,
    description: "One page of matching transactions, in register shape",
  })
  @ApiResponse({ status: 400, description: "Invalid condition" })
  matchDraft(
    @Request() req: { user: { id: string } },
    @Body() dto: MatchDraftRuleDto,
  ) {
    return this.matchService.matchDraft(req.user.id, dto);
  }

  // Registered before the `:id` routes, like "preview-draft". Read-only: the
  // global throttler applies, as it does to preview-draft.
  @Post("explain-row")
  @PatScope("read")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Test one row (an import preview's) against my rules: each rule's condition tree and effects (writes nothing)",
  })
  @ApiResponse({
    status: 200,
    description: "Every rule in order, with its condition explained",
  })
  @ApiResponse({
    status: 400,
    description: "Invalid row, or it names an item that is not mine",
  })
  explainRow(
    @Request() req: { user: { id: string } },
    @Body() dto: ExplainRuleRowDto,
  ) {
    return this.runService.explainRow(req.user.id, dto);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a rule" })
  @ApiResponse({ status: 200, type: TransactionRuleResponseDto })
  @ApiResponse({ status: 404, description: "Rule not found" })
  findOne(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.rulesService.get(req.user.id, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a rule (compare-and-swap on revision)" })
  @ApiResponse({ status: 200, type: TransactionRuleResponseDto })
  @ApiResponse({ status: 404, description: "Rule not found" })
  @ApiResponse({ status: 409, description: "Stale revision" })
  update(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateTransactionRuleDto,
  ) {
    return this.rulesService.update(req.user.id, id, dto);
  }

  @Patch(":id/enabled")
  @ApiOperation({ summary: "Enable or disable a rule" })
  @ApiResponse({ status: 200, type: TransactionRuleResponseDto })
  @ApiResponse({ status: 404, description: "Rule not found" })
  setEnabled(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SetTransactionRuleEnabledDto,
  ) {
    return this.rulesService.setEnabled(req.user.id, id, dto.enabled);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete a rule and close the gap in the order" })
  @ApiResponse({ status: 204, description: "Rule deleted" })
  @ApiResponse({ status: 404, description: "Rule not found" })
  remove(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.rulesService.remove(req.user.id, id);
  }

  @Post(":id/preview-run")
  @PatScope("read")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Preview running a rule on existing transactions (writes nothing)",
  })
  @ApiResponse({
    status: 200,
    description: "Planned changes and a fingerprint",
  })
  @ApiResponse({ status: 404, description: "Rule not found" })
  previewRun(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RuleRunFiltersDto,
  ) {
    return this.runService.previewRun(req.user.id, id, dto);
  }

  @Post(":id/run")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Run a rule on existing transactions (one undoable history entry)",
  })
  @ApiResponse({ status: 200, description: "Rows changed, skipped, historyId" })
  @ApiResponse({ status: 404, description: "Rule not found" })
  @ApiResponse({ status: 409, description: "PREVIEW_CHANGED: preview again" })
  run(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RunTransactionRuleDto,
  ) {
    return this.runService.run(req.user.id, id, dto);
  }

  @Get(":id/applications")
  @ApiOperation({ summary: "The latest applications of a rule (its trace)" })
  @ApiResponse({ status: 404, description: "Rule not found" })
  applications(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Query(
      "limit",
      new DefaultValuePipe(DEFAULT_RULE_APPLICATIONS_LIMIT),
      ParseIntPipe,
    )
    limit: number,
  ) {
    return this.runService.applications(req.user.id, id, limit);
  }
}
