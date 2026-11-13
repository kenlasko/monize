import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { OwnerOnly } from "../../delegation/decorators/delegate-access.decorator";
import { EmailReceiptAiService } from "../ai/email-receipt-ai.service";
import {
  ApprovableEmailReceiptsDto,
  AskAiEmailReceiptDto,
  BulkReprocessEmailReceiptsDto,
  CountEmailReceiptsDto,
  BulkEmailReceiptFilterDto,
  BulkEmailReceiptsDto,
  EmailReceiptStatusCountsDto,
  ListEmailReceiptDomainsDto,
  LinkEmailReceiptDto,
  ListEmailReceiptsDto,
  ProcessBatchEmailReceiptsDto,
  ProfileBatchEmailReceiptsDto,
} from "./dto/email-receipts.dto";
import { EmailReceiptProfileBatchService } from "./email-receipt-profile-batch.service";
import { EmailReceiptsService } from "./email-receipts.service";
import type { ReceiptBulkTarget } from "./receipt-bulk";
import { AllowPat, PatScope } from "../../auth/pat-access/pat-access.decorator";

/** The emails a request names: its ids, or the filter as the DTO carries it. */
function targetOf(dto: {
  ids?: string[];
  filter?: BulkEmailReceiptFilterDto;
}): ReceiptBulkTarget {
  return dto.ids !== undefined
    ? { ids: dto.ids }
    : {
        filter: {
          status: dto.filter?.status,
          domain: dto.filter?.domain,
          excludeStatuses: dto.filter?.excludeStatuses,
          excludeDomains: dto.filter?.excludeDomains,
          receivedFrom: dto.filter?.receivedFrom,
          receivedTo: dto.filter?.receivedTo,
          search: dto.filter?.search,
          searchIn: dto.filter?.searchIn,
          dateFrom: dto.filter?.dateFrom,
          dateTo: dto.filter?.dateTo,
        },
      };
}

/**
 * The stored order-confirmation emails (design sections 6 and 8): the list, one
 * email, and what a person does with it. Owner-only: a delegate ("acting as")
 * session is refused on every route, since an email and its proposal belong to
 * the owner alone. `userId` is the JWT's, never the request's.
 *
 * `email-receipts/mailbox` is the mailbox controller's and is registered first
 * in the module, so `:id` (a UUID, by `ParseUUIDPipe`) never sees it.
 */
@ApiTags("Email Receipts")
@AllowPat()
@Controller("email-receipts")
@UseGuards(AuthGuard("jwt"))
@OwnerOnly()
@ApiBearerAuth()
export class EmailReceiptsController {
  constructor(
    private readonly receipts: EmailReceiptsService,
    private readonly ai: EmailReceiptAiService,
    private readonly profileBatches: EmailReceiptProfileBatchService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "List my stored emails, newest first (no text), with their state",
  })
  list(
    @Request() req: { user: { id: string } },
    @Query() query: ListEmailReceiptsDto,
  ) {
    return this.receipts.list(req.user.id, {
      status: query.status,
      domain: query.domain,
      limit: query.limit,
      offset: query.offset,
      search: query.search,
      searchIn: query.searchIn,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
  }

  // Declared before `:id`, so the literal segment is matched first.
  @Get("domains")
  @ApiOperation({
    summary:
      "The sender domains of my stored emails with their counts, most first (at most 200); `status` keeps only the emails in that state",
  })
  domains(
    @Request() req: { user: { id: string } },
    @Query() query: ListEmailReceiptDomainsDto,
  ) {
    return this.receipts.listDomains(req.user.id, {
      status: query.status,
      search: query.search,
      searchIn: query.searchIn,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
  }

  // Declared before `:id`, so the literal segment is matched first.
  @Get("domains/uncovered")
  @ApiOperation({
    summary:
      "The sender domains of my stored emails that no approved profile covers, with their counts and the draft profile for each, if any (at most 200)",
  })
  uncoveredDomains(@Request() req: { user: { id: string } }) {
    return this.receipts.listUncoveredDomains(req.user.id);
  }

  // Declared before `:id`, so the literal segment is matched first.
  @Get("status-counts")
  @ApiOperation({
    summary:
      "How many of my stored emails are in each state, optionally only from one sender domain",
  })
  statusCounts(
    @Request() req: { user: { id: string } },
    @Query() query: EmailReceiptStatusCountsDto,
  ) {
    return this.receipts.statusCounts(req.user.id, {
      domain: query.domain,
      search: query.search,
      searchIn: query.searchIn,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
  }

  // Declared before `:id`, so the literal segment is matched first.
  @Get("overview")
  @ApiOperation({
    summary:
      "What the Email receipts hub's Overview shows: the mailbox, the emails by status, the profiles, the proposals to approve (one query)",
  })
  overview(@Request() req: { user: { id: string } }) {
    return this.receipts.overview(req.user.id);
  }

  @Post("process-batch")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({
    summary:
      "Run the pipeline over up to `limit` emails in the given statuses, oldest first, one after the other; answers where they ended and how many are left",
  })
  processBatch(
    @Request() req: { user: { id: string } },
    @Body() dto: ProcessBatchEmailReceiptsDto,
  ) {
    return this.receipts.processBatch(req.user.id, {
      domain: dto.domain,
      statuses: dto.statuses,
      limit: dto.limit,
      since: dto.since,
    });
  }

  // Declared before `:id`, so the literal segment is matched first.
  @Post("bulk")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary:
      "Delete or ignore many stored emails, by id or by the list's filter; refuses with 409 and writes nothing when the number of matching emails differs from `expectedCount`. Emails linked to a transaction are skipped",
  })
  bulk(
    @Request() req: { user: { id: string } },
    @Body() dto: BulkEmailReceiptsDto,
  ) {
    return this.receipts.bulk(
      req.user.id,
      dto.action,
      targetOf(dto),
      dto.expectedCount,
    );
  }

  // Declared before `:id`, so the literal segment is matched first.
  @Post("bulk/count")
  @PatScope("read")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({
    summary:
      "How many stored emails a filter selects (the state, the sender domain, what is taken out and the received dates), capped just above the bulk limit",
  })
  bulkCount(
    @Request() req: { user: { id: string } },
    @Body() dto: CountEmailReceiptsDto,
  ) {
    return this.receipts.countSelection(req.user.id, dto.filter);
  }

  // Declared before `:id`, so the literal segment is matched first.
  @Post("bulk/reprocess")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({
    summary:
      'Run the pipeline over up to `limit` of the selected emails (by id or filter), oldest first, each once per run; answers where they ended and how many are left. Call again with the returned `since` until `remaining` is 0. `onlyStatuses: ["ignored"]` restores ignored emails',
  })
  bulkReprocess(
    @Request() req: { user: { id: string } },
    @Body() dto: BulkReprocessEmailReceiptsDto,
  ) {
    return this.receipts.reprocessSelection(req.user.id, targetOf(dto), {
      onlyStatuses: dto.onlyStatuses,
      since: dto.since,
      limit: dto.limit,
    });
  }

  // Declared before `:id`, so the literal segment is matched first.
  @Post("bulk/approvable")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({
    summary:
      "The request ids of the selected emails whose proposal can be approved (at most 2,000; more is a 400) and how many trade emails were left out",
  })
  bulkApprovable(
    @Request() req: { user: { id: string } },
    @Body() dto: ApprovableEmailReceiptsDto,
  ) {
    return this.receipts.approvableSelection(req.user.id, targetOf(dto));
  }

  @Post("profile-batch")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({
    summary:
      "Count, ignore or delete the stored emails a profile matches (as the pipeline chooses the profile), a page per call; answers what it found and did, and the cursor of the next page",
  })
  profileBatch(
    @Request() req: { user: { id: string } },
    @Body() dto: ProfileBatchEmailReceiptsDto,
  ) {
    return this.profileBatches.run(
      req.user.id,
      dto.parserId,
      dto.action,
      dto.after,
    );
  }

  @Get(":id")
  @ApiOperation({
    summary:
      "One stored email with its text, what the parser read and the candidates",
  })
  get(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.receipts.get(req.user.id, id);
  }

  @Post(":id/reprocess")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: "Run an email through the pipeline again" })
  reprocess(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.receipts.reprocess(req.user.id, id);
  }

  @Post(":id/link")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: "Link an email to the transaction it paid for" })
  link(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: LinkEmailReceiptDto,
  ) {
    return this.receipts.link(req.user.id, id, dto.transactionId);
  }

  @Post(":id/ignore")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Ignore an email: it proposes nothing" })
  ignore(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.receipts.ignore(req.user.id, id);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Delete a stored email and dismiss its open request",
  })
  async remove(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.receipts.remove(req.user.id, id);
  }

  @Post(":id/ask-ai")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary:
      "Queue an AI review request for the email's transaction (optionally a chosen one); the assistant in the chat answers it",
  })
  askAi(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AskAiEmailReceiptDto,
  ) {
    return this.ai.askAi(req.user.id, id, dto.transactionId || null, {
      asTrade: dto.asTrade === true,
    });
  }
}
