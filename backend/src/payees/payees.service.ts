import {
  beginTaxonomyOperation,
  recordTaxonomyOperation,
} from "../accruals/accrual-taxonomy-operation";
import { accrualErrors } from "../accruals/accrual-errors";
import {
  beginPayeeRelationshipHistory,
  recordRelationshipHistory,
} from "../accruals/accrual-relationship-history";
import { preparePayeeRemoval, removePayeeWithAccruals } from "./payee-removal";
import { prepareSuggestionCategoryBatch } from "./payee-category-batch";
import {
  preparePayeeCategoryEdit,
  applyPayeeCategoryEdit,
} from "./payee-category-impact";
import { verifyBulkAccrualEdit } from "../accruals/accrual-bulk-edit";
import {
  lockPayeeSources,
  updatePayeeSourceMetadata,
} from "./payee-source-metadata";
import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { isEmail } from "class-validator";
import { tr } from "../i18n/translate";
import { DataSource, Like, In, Not, IsNull } from "typeorm";
import { Payee } from "./entities/payee.entity";
import { PayeeAlias } from "./entities/payee-alias.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { Category } from "../categories/entities/category.entity";
import {
  loadQualifiedCategoryNames,
  qualifiedNamesById,
  resolveCategoryNamePaths,
} from "../categories/category-name.util";
import { CreatePayeeDto } from "./dto/create-payee.dto";
import { UpdatePayeeDto } from "./dto/update-payee.dto";
import { CreatePayeeAliasDto } from "./dto/create-payee-alias.dto";
import { MergePayeeDto } from "./dto/merge-payee.dto";
import { ActionHistoryService } from "../action-history/action-history.service";
import { toCountMap } from "../common/count-map.util";
import { matchesAliasPattern } from "./alias-match.util";
import { insertPayeeAliasIgnoringDuplicate } from "./insert-payee-alias.util";
import { countUncategorizedTransactionsByPayee } from "./payee-backfill.util";
import { stripHtml } from "../common/sanitization.util";
import type { LlmPayeeList, LlmPayeeQuery } from "./llm-payee-query";
import { getActiveScopedManager, withScopedDb } from "../common/db/scoped-db";
import { normalizeWebsite } from "../common/normalize-website";
import {
  formatPhoneForDisplay,
  normalizePhoneOrThrow,
  resolveUserPhoneRegion,
} from "../common/phone-number.util";
import type { CountryCode } from "libphonenumber-js/max";
import { FaviconService, FetchedLogo } from "../common/favicon/favicon.service";
import { brandLogoColumns } from "../common/favicon/brand-logo.columns";
import { PayeeContactLookupService } from "./lookup/payee-contact-lookup.service";
import { ContactLookupOutcome } from "./lookup/payee-contact-lookup.types";
import { buildLookupContext } from "./lookup/lookup-context";
import { PayeeContactEnrichmentService } from "./lookup/payee-contact-enrichment.service";
import { ContactLookupSource } from "./lookup/payee-contact-lookup.types";

/**
 * What a preview established about a contact lookup, carried to the commit
 * so the row is stamped with the same provenance the card was built from.
 */
export interface ContactLookupStamp {
  /** null when the lookup answered but found nothing. */
  source: ContactLookupSource | null;
  attemptedAt: Date;
}

export interface CreatePayeeOptions {
  /**
   * Provenance from a preview that already looked the payee up (AI/MCP
   * confirmation flow). Written with the row; suppresses the background
   * lookup, which would otherwise repeat work the user already approved.
   */
  contactLookup?: ContactLookupStamp;

  /**
   * The caller is offering the lookup to the user itself (the transaction
   * page's payee quick-create runs it and shows the confirmation dialogue), so
   * the automatic background lookup must not also run and write. Without it
   * the same payee is looked up twice -- two paid calls -- and the values the
   * dialogue offers have already been stored behind the user.
   */
  deferContactLookup?: boolean;
}

export interface PreviewCreateOptions {
  /**
   * Fill contact details the caller did not supply through the user's
   * contact lookup (when they have enabled it), so the confirmation card
   * shows what the commit will store.
   */
  lookupContact?: boolean;
}

/**
 * Resolved, sanitized preview of a proposed new payee. Shared by the AI
 * Assistant human-in-the-loop confirmation flow so the preview matches what
 * `create()` would persist.
 */
export interface CreatePayeePreview {
  name: string;
  defaultCategoryId: string | null;
  defaultCategoryName: string | null;
  /**
   * The website as it would be stored -- already normalised, so the card the
   * user approves shows the address the commit will write rather than the
   * bare domain they typed. `undefined` means the request said nothing about
   * it; `null` means clear it.
   */
  website?: string | null;
  /** Contact fields, with the same undefined/null contract as {@link website}. */
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  /**
   * Present when this preview ran a contact lookup (see
   * {@link PreviewCreateOptions.lookupContact}); the commit stores it.
   */
  contactLookup?: ContactLookupStamp;
}

/**
 * Resolved preview of a proposed payee edit. Carries the resulting name and
 * default category so the AI Assistant confirmation card shows what the edit
 * will do and confirm applies an idempotent overwrite of the identified payee.
 */
export interface UpdatePayeePreview {
  payeeId: string;
  name: string;
  defaultCategoryId: string | null;
  defaultCategoryName: string | null;
  /** See {@link CreatePayeePreview.website}. */
  website?: string | null;
  /**
   * Contact fields, with the same contract as {@link website}: `undefined`
   * leaves the stored value alone, `null` clears it.
   */
  address?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** Resolved preview of a proposed payee deletion. */
export interface DeletePayeePreview {
  payeeId: string;
  name: string;
}

function escapeLikeWildcards(value: string): string {
  // Escape backslash first, then the LIKE wildcards. Escaping only the
  // wildcards would leave backslashes unescaped, letting an attacker submit
  // '\%' and neutralise the escaping (CWE-20).
  return value.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
}

/**
 * Normalize a payee name for tolerant matching. Apostrophes are dropped so
 * "Zehr's" and "Zehrs" collapse together; any other punctuation or whitespace
 * run folds to a single space. Lower-cased and trimmed. Used only for the
 * fuzzy resolveByName fallback -- never for persistence.
 */
function normalizePayeeName(value: string): string {
  return value
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * What a contact field the user emptied should be stored as.
 *
 * The form resends every field on each save, so a cleared input arrives as "" --
 * which must become NULL rather than an empty string, or "has an address" reads
 * true for a payee with none and the map renders an empty query. Undefined is
 * left alone: it means the caller did not mention the field at all.
 */
function normalizeContactField(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The contact fields as they will be STORED: trimmed, blanks read as clears,
 * the email checked and the phone normalized to E.164.
 *
 * Every writer goes through here -- the preview an AI or MCP card is built
 * from, and the create and update that commit -- because a preview has to
 * compute what the commit will do. Checking only at commit time would show the
 * user a confirmation card, take their approval, and then fail the request
 * they had already agreed to; normalizing only at commit time would show them
 * "(206) 448-8762" on the card and store something else.
 *
 * `region` places a number written without a country code (see
 * `phone-number.util.ts`). It is `null` where the caller could not resolve one,
 * which makes a bare national number a refusal rather than a guess.
 */
function previewContactFields(
  input: {
    address?: string | null;
    email?: string | null;
    phone?: string | null;
  },
  region: CountryCode | null,
): { address?: string | null; email?: string | null; phone?: string | null } {
  const email = normalizeContactField(input.email);
  if (email && !isEmail(email)) {
    throw new BadRequestException(
      tr(
        "errors.payees.invalidEmail",
        `"${email}" is not a valid email address`,
        {
          email,
        },
      ),
    );
  }
  const phone = normalizeContactField(input.phone);
  return {
    address: normalizeContactField(input.address),
    email,
    phone: phone ? normalizePhoneOrThrow(phone, region) : phone,
  };
}

@Injectable()
export class PayeesService {
  private readonly logger = new Logger(PayeesService.name);

  constructor(
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
    private faviconService: FaviconService,
    private contactLookup: PayeeContactLookupService,
    private contactEnrichment: PayeeContactEnrichmentService,
  ) {}

  /**
   * The contact fields as they will be stored, resolving the caller's phone
   * region only when there is a number that needs placing.
   *
   * The laziness is the point: a region is one more query, and the great
   * majority of payees carry no phone at all. Every writer -- preview, create
   * and update alike -- goes through here, so all of them place a number the
   * same way.
   */
  private async storableContactFields(
    userId: string,
    input: {
      address?: string | null;
      email?: string | null;
      phone?: string | null;
    },
    /**
     * The phone the row already holds, where there is one. A value equal to it
     * did not move, so it is passed through untouched -- the same rule `update`
     * applies, and a preview that did not share it would refuse an edit the
     * commit would accept.
     */
    currentPhone?: string | null,
  ): Promise<{
    address?: string | null;
    email?: string | null;
    phone?: string | null;
  }> {
    const phone = normalizeContactField(input.phone);
    if (phone && currentPhone && phone === currentPhone) {
      return {
        ...previewContactFields({ ...input, phone: null }, null),
        phone,
      };
    }
    const region = phone
      ? await resolveUserPhoneRegion(this.dataSource, userId)
      : null;
    return previewContactFields(input, region);
  }

  async create(
    userId: string,
    createPayeeDto: CreatePayeeDto,
    options: CreatePayeeOptions = {},
  ): Promise<Payee> {
    // The DTO accepts "starbucks.com"; a stored link needs its scheme or the
    // anchor resolves it relative to the current page -- and the favicon
    // resolver needs an absolute address too.
    const website = normalizeWebsite(createPayeeDto.website) ?? null;
    // Best-effort: never fail creation because the favicon could not be
    // fetched. The HTTP fetch stays outside any transaction so a slow remote
    // host cannot hold a database connection open.
    const logo = website
      ? await this.faviconService.fetchFavicon(website)
      : null;

    // The contact fields the form sends as "" mean "empty", not "a blank
    // string" -- see normalizeContactField -- and a phone is stored in one
    // canonical form whichever door wrote it. Through the same function the
    // preview uses, so an AI or MCP card cannot show one value and the commit
    // store another; it throws before the transaction below opens, so a
    // refused number leaves nothing written.
    const contact = await this.storableContactFields(userId, createPayeeDto);
    const address = contact.address ?? null;
    const email = contact.email ?? null;
    const phone = contact.phone ?? null;
    const saved = await withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(Payee);
      // Check if payee with same name already exists for this user
      const existing = await repo.findOne({
        where: {
          userId,
          name: createPayeeDto.name,
        },
      });

      if (existing) {
        throw new ConflictException(
          tr(
            "errors.payees.nameConflict",
            `Payee with name "${createPayeeDto.name}" already exists`,
            { name: createPayeeDto.name },
          ),
        );
      }

      const payee = repo.create({
        ...createPayeeDto,
        website,
        // No website is "never looked for", which logo_fetched_at records as
        // null -- so the columns are only written when there was an address
        // to resolve.
        ...(website ? brandLogoColumns(logo) : {}),
        address,
        email,
        phone,
        ...(options.contactLookup
          ? {
              contactLookupAt: options.contactLookup.attemptedAt,
              contactLookupSource: options.contactLookup.source,
            }
          : {}),
        userId,
      });

      return repo.save(payee);
    });

    this.actionHistoryService.record(userId, {
      entityType: "payee",
      entityId: saved.id,
      action: "create",
      afterData: {
        id: saved.id,
        name: saved.name,
        notes: saved.notes,
        website: saved.website,
        address: saved.address,
        email: saved.email,
        phone: saved.phone,
        defaultCategoryId: saved.defaultCategoryId,
        isActive: saved.isActive,
      },
      description: `Created payee "${saved.name}"`,
      descriptionKey: "createdPayee",
      descriptionParams: { name: saved.name },
    });

    // A payee created with no contact details at all -- a name-only AI/MCP
    // row, a payee the server created while saving a transaction -- is looked
    // up in the background, when the user has enabled that. Four conditions,
    // each load-bearing: the preview path already looked up (its stamp travels
    // in `options`); the caller is running the lookup itself and will ask the
    // user (`deferContactLookup`), so a background write would both duplicate
    // the cost and pre-empt the answer they are about to confirm; something
    // was supplied (the user's own values are never second-guessed); and there
    // is no ambient transaction, because this
    // runs after `withScopedDb` resolved, and "resolved" only means
    // "committed" when nobody upstream opened a transaction we joined -- a
    // dispatch inside one would look for a row nobody else can see yet.
    if (
      !options.contactLookup &&
      !options.deferContactLookup &&
      !website &&
      !address &&
      !email &&
      !phone &&
      getActiveScopedManager() === undefined
    ) {
      // No contact detail was supplied, but a note may still say which
      // organisation and which place this is ("Toronto branch") -- context
      // for the lookup, never a field it writes.
      this.contactEnrichment.dispatchAfterCreate(
        userId,
        saved.id,
        saved.name,
        buildLookupContext({ notes: saved.notes }),
      );
    }
    return saved;
  }

  /**
   * Validate and resolve a proposed new payee WITHOUT persisting it. Sanitizes
   * the name, rejects duplicates, and resolves the optional default category to
   * a display name. Used by the AI Assistant confirmation flow.
   */
  async previewCreate(
    userId: string,
    input: {
      name: string;
      defaultCategoryId?: string | null;
      website?: string | null;
      address?: string | null;
      email?: string | null;
      phone?: string | null;
    },
    options: PreviewCreateOptions = {},
  ): Promise<CreatePayeePreview> {
    const name = stripHtml(input.name)?.trim() || "";
    let contact = await this.storableContactFields(userId, input);
    // Normalise here, not at commit time: a preview has to compute what the
    // commit will do, so the card shows "https://acme.com" for a typed
    // "acme.com" rather than a value the save would then change.
    let website = normalizeWebsite(input.website);

    // The lookup runs before the transaction below (it is a provider call)
    // and only when the row carries no contact details at all: a value the
    // caller typed is never second-guessed, and a preview that looked up
    // hands its stamp to the commit so the card and the row agree.
    let contactLookup: ContactLookupStamp | undefined;
    if (
      options.lookupContact &&
      name &&
      !website &&
      !contact.address &&
      !contact.email &&
      !contact.phone
    ) {
      const outcome = await this.contactLookup.lookup(userId, { name });
      if (outcome.reason === "ok") {
        // A preview card is built before anyone can be asked, so it takes the
        // best match; the alternates are for a surface with a user on it.
        const best = outcome.suggestions[0];
        website = best.website ?? undefined;
        contact = {
          address: best.address ?? undefined,
          email: best.email ?? undefined,
          phone: best.phone ?? undefined,
        };
        contactLookup = {
          source: best.source,
          attemptedAt: new Date(),
        };
      } else if (outcome.reason === "none") {
        contactLookup = { source: null, attemptedAt: new Date() };
      }
    }

    return withScopedDb(this.dataSource, async (m) => {
      const existing = await m.getRepository(Payee).findOne({
        where: { userId, name },
      });
      if (existing) {
        throw new ConflictException(
          tr(
            "errors.payees.nameConflict",
            `Payee with name "${name}" already exists`,
            { name },
          ),
        );
      }

      let defaultCategoryName: string | null = null;
      const defaultCategoryId = input.defaultCategoryId ?? null;
      if (defaultCategoryId) {
        const cat = await m.getRepository(Category).findOne({
          where: { id: defaultCategoryId, userId },
        });
        if (!cat) {
          throw new NotFoundException(
            tr("errors.transactions.categoryNotFound", "Category not found"),
          );
        }
        // Qualified: this name goes on a confirmation card the user approves,
        // and "Cell Phone" alone does not say which "Cell Phone" they are
        // about to file every future transaction under.
        const names = await loadQualifiedCategoryNames(m, userId);
        defaultCategoryName = names.get(cat.id) ?? cat.name;
      }

      return {
        name,
        defaultCategoryId,
        defaultCategoryName,
        website,
        ...contact,
        ...(contactLookup ? { contactLookup } : {}),
      };
    });
  }

  /**
   * Resolve a category name (optionally "Parent: Child") to its id and display
   * name for the manage_payees default-category field. Names everywhere -- the
   * tool layers pass names and this resolves them so both surfaces behave the
   * same. Throws NotFound when the name matches nothing.
   */
  private async resolveCategoryByName(
    userId: string,
    categoryName: string,
  ): Promise<{ id: string; name: string }> {
    const match = await withScopedDb(this.dataSource, async (m) => {
      const categories = await m.getRepository(Category).find({
        where: { userId },
        select: ["id", "name", "parentId"],
      });
      const [resolution] = resolveCategoryNamePaths(categories, [categoryName]);
      const names = qualifiedNamesById(categories);
      return resolution.id
        ? { id: resolution.id, name: names.get(resolution.id) ?? categoryName }
        : null;
    });
    if (!match) {
      throw new NotFoundException(
        tr(
          "errors.transactions.categoryNotFound",
          `Unknown category: ${categoryName}`,
          { name: categoryName },
        ),
      );
    }
    return match;
  }

  /**
   * Resolve a payee by its current name for an edit/delete, throwing NotFound
   * when no payee matches. Used by the manage_payees confirmation flow.
   */
  private async resolvePayeeForManage(
    userId: string,
    name: string,
  ): Promise<Payee> {
    const payee = await this.findByName(userId, name);
    if (!payee) {
      throw new NotFoundException(
        tr("errors.payees.notFound", `Payee "${name}" not found`, {
          id: name,
        }),
      );
    }
    return payee;
  }

  /**
   * Validate + resolve a proposed new payee from NAMES (the category is given by
   * name, not id), reusing previewCreate for the duplicate/sanitize checks.
   */
  async previewCreatePayee(
    userId: string,
    input: {
      name: string;
      categoryName?: string | null;
      website?: string | null;
      address?: string | null;
      email?: string | null;
      phone?: string | null;
    },
    options: PreviewCreateOptions = {},
  ): Promise<CreatePayeePreview> {
    let defaultCategoryId: string | null = null;
    if (input.categoryName) {
      defaultCategoryId = (
        await this.resolveCategoryByName(userId, input.categoryName)
      ).id;
    }
    return this.previewCreate(
      userId,
      {
        name: input.name,
        defaultCategoryId,
        website: input.website,
        address: input.address,
        email: input.email,
        phone: input.phone,
      },
      options,
    );
  }

  /**
   * Validate + resolve a proposed payee edit WITHOUT persisting. Resolves the
   * target payee by its current name, sanitizes/checks any new name for
   * conflicts, and resolves the optional new default category by name.
   */
  async previewUpdatePayee(
    userId: string,
    input: {
      name: string;
      newName?: string;
      categoryName?: string | null;
      website?: string | null;
      address?: string | null;
      email?: string | null;
      phone?: string | null;
    },
  ): Promise<UpdatePayeePreview> {
    const payee = await this.resolvePayeeForManage(userId, input.name);

    let name = payee.name;
    if (input.newName !== undefined) {
      const sanitized = stripHtml(input.newName)?.trim() || "";
      if (!sanitized) {
        throw new BadRequestException(
          tr("errors.payees.nameRequired", "Payee name is required"),
        );
      }
      if (sanitized !== payee.name) {
        const existing = await withScopedDb(this.dataSource, (m) =>
          m.getRepository(Payee).findOne({
            where: { userId, name: sanitized },
          }),
        );
        if (existing) {
          throw new ConflictException(
            tr(
              "errors.payees.nameConflict",
              `Payee with name "${sanitized}" already exists`,
              { name: sanitized },
            ),
          );
        }
      }
      name = sanitized;
    }

    let defaultCategoryId: string | null = payee.defaultCategoryId;
    let defaultCategoryName: string | null =
      payee.defaultCategory?.name ?? null;
    if (input.categoryName !== undefined) {
      if (input.categoryName === null || input.categoryName === "") {
        defaultCategoryId = null;
        defaultCategoryName = null;
      } else {
        const cat = await this.resolveCategoryByName(
          userId,
          input.categoryName,
        );
        defaultCategoryId = cat.id;
        defaultCategoryName = cat.name;
      }
    }

    // Absent means "leave the stored address alone"; "" or null clears it.
    // Normalised here so the card shows the value the commit will store.
    const website =
      input.website === undefined
        ? undefined
        : (normalizeWebsite(input.website) ?? null);

    return {
      payeeId: payee.id,
      name,
      defaultCategoryId,
      defaultCategoryName,
      website,
      ...(await this.storableContactFields(userId, input, payee.phone)),
    };
  }

  /** Validate + resolve a proposed payee deletion (by name) WITHOUT persisting. */
  async previewDeletePayee(
    userId: string,
    input: { name: string },
  ): Promise<DeletePayeePreview> {
    const payee = await this.resolvePayeeForManage(userId, input.name);
    return { payeeId: payee.id, name: payee.name };
  }

  async findAll(
    userId: string,
    status?: "active" | "inactive" | "all",
  ): Promise<
    (Payee & {
      transactionCount: number;
      lastUsedDate: string | null;
      aliasCount: number;
      uncategorizedCount: number;
    })[]
  > {
    // Build where clause based on status filter
    const where: any = { userId };
    if (status === "active") {
      where.isActive = true;
    } else if (status === "inactive") {
      where.isActive = false;
    }
    // "all" or undefined = no isActive filter

    return withScopedDb(this.dataSource, async (m) => {
      // Get all payees with their default category
      const payees = await m.getRepository(Payee).find({
        where,
        relations: ["defaultCategory"],
        order: { name: "ASC" },
      });

      if (payees.length === 0) {
        return [];
      }

      // Get transaction counts and last used dates for all payees in one query
      const stats = await m
        .getRepository(Payee)
        .createQueryBuilder("payee")
        .leftJoin(
          "transactions",
          "transaction",
          "transaction.payee_id = payee.id AND transaction.user_id = :userId",
          { userId },
        )
        .where("payee.user_id = :userId", { userId })
        .groupBy("payee.id")
        .select([
          "payee.id as id",
          "COUNT(transaction.id) as count",
          "MAX(transaction.transaction_date) as last_used_date",
        ])
        .getRawMany();

      // Get alias counts for all payees in one query
      const aliasCounts = await m
        .getRepository(PayeeAlias)
        .createQueryBuilder("alias")
        .where("alias.user_id = :userId", { userId })
        .groupBy("alias.payee_id")
        .select([
          "alias.payee_id as payee_id",
          "COUNT(alias.id) as alias_count",
        ])
        .getRawMany();

      // Create maps for counts and last used dates
      const countMap = toCountMap(stats);
      const lastUsedMap = new Map<string, string | null>();
      for (const row of stats) {
        lastUsedMap.set(row.id, row.last_used_date || null);
      }

      const aliasCountMap = toCountMap(aliasCounts, {
        keyField: "payee_id",
        countField: "alias_count",
      });

      // Per-payee count of transactions with no category (excluding transfers
      // and split parents) -- the same scope the default-category backfill
      // targets -- so the list can flag payees that still have uncategorized
      // transactions.
      const uncategorizedCountMap = await countUncategorizedTransactionsByPayee(
        m,
        userId,
      );

      // Merge stats with payees
      return payees.map((payee) => ({
        ...payee,
        transactionCount: countMap.get(payee.id) || 0,
        lastUsedDate: lastUsedMap.get(payee.id) || null,
        aliasCount: aliasCountMap.get(payee.id) || 0,
        uncategorizedCount: uncategorizedCountMap.get(payee.id) || 0,
      }));
    });
  }

  /**
   * The payee list the AI Assistant and the MCP `list_payees` tool both read.
   *
   * Built on `findAll`, so the derived figures (transaction count, last used,
   * alias and uncategorized counts) are computed in exactly one place; this adds
   * the filtering, ordering and truncation a model needs to ask a narrow
   * question instead of reading every payee.
   *
   * Two things it will not do. The search is a case-insensitive SUBSTRING match
   * -- `search` used SQL `LIKE`, which Postgres evaluates case-sensitively, so
   * "amazon" matched nothing while "Amazon" did, and the tool looked like it
   * only accepted exact names. And a truncated list says so: `totalCount` is
   * what matched, `payees.length` is what came back, and `truncated` is the
   * difference, because a capped list presented as the whole one is the same
   * defect as a subtotal presented as a total.
   */
  async getLlmPayees(
    userId: string,
    options: LlmPayeeQuery = {},
  ): Promise<LlmPayeeList> {
    const rows = await this.findAll(userId, options.status ?? "all");

    const search = options.search?.trim().toLowerCase();
    const wanted = (
      required: boolean | undefined,
      value: string | null | undefined,
    ) => required === undefined || Boolean(value) === required;

    const matched = rows.filter(
      (payee) =>
        (!search || payee.name.toLowerCase().includes(search)) &&
        wanted(options.hasWebsite, payee.website) &&
        wanted(options.hasAddress, payee.address) &&
        wanted(options.hasEmail, payee.email) &&
        wanted(options.hasPhone, payee.phone) &&
        (options.hasLogo === undefined || payee.hasLogo === options.hasLogo) &&
        (options.hasDefaultCategory === undefined ||
          Boolean(payee.defaultCategoryId) === options.hasDefaultCategory),
    );

    const byName = (a: Payee, b: Payee) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    const sorted = [...matched].sort((a, b) => {
      switch (options.sortBy) {
        case "transactionCount":
          // Busiest first; a tie is ordered by name so the page is stable.
          return b.transactionCount - a.transactionCount || byName(a, b);
        case "lastUsed":
          // Most recent first. A payee never used has no date, and an unknown
          // date sorts last rather than pretending to be the oldest.
          if (a.lastUsedDate === b.lastUsedDate) return byName(a, b);
          if (!a.lastUsedDate) return 1;
          if (!b.lastUsedDate) return -1;
          return b.lastUsedDate.localeCompare(a.lastUsedDate);
        default:
          return byName(a, b);
      }
    });

    const limit = options.limit;
    const payees =
      limit !== undefined && limit < sorted.length
        ? sorted.slice(0, limit)
        : sorted;

    return {
      // A model quotes these rows back to the reader, so the phone travels in
      // the form a person reads -- the same decision the AI executor's
      // `contactSummary` and the MCP contact card make about a preview. Stored
      // E.164 is how the column compares two numbers, not an answer to "what is
      // their number?", and a surface that hands it over unformatted is how one
      // number ends up printed two ways in one product.
      payees: payees.map((payee) => ({
        ...payee,
        phone: payee.phone ? formatPhoneForDisplay(payee.phone) : payee.phone,
      })),
      totalCount: matched.length,
      truncated: payees.length < matched.length,
    };
  }

  async findOne(userId: string, id: string): Promise<Payee> {
    const payee = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Payee).findOne({
        where: { id, userId },
        relations: ["defaultCategory"],
      }),
    );

    if (!payee) {
      throw new NotFoundException(
        tr("errors.payees.notFound", `Payee with ID ${id} not found`, { id }),
      );
    }

    return payee;
  }

  /**
   * Look an existing payee's contact details up WITHOUT writing anything.
   *
   * The detail screen's button is a proposal, not a save: the user confirms
   * what changes (and, where the name means more than one organisation or
   * branch, which of them they are paying) and the confirmation goes through
   * `update` as their own edit. So this method reads the row -- for the
   * ownership check and for the context that tells the lookup which place is
   * meant -- and returns the candidates.
   */
  async lookupContactForPayee(
    userId: string,
    payeeId: string,
  ): Promise<ContactLookupOutcome> {
    const payee = await this.findOne(userId, payeeId);
    return this.contactLookup.lookup(
      userId,
      { name: payee.name, known: buildLookupContext(payee) },
      // The click is the consent, whether or not the automatic lookup is on.
      { ignorePreference: true },
    );
  }

  /**
   * Load the cached favicon bytes for streaming. Throws NotFound when the
   * payee is missing or has no cached logo -- the client renders its own
   * fallback badge from that 404.
   */
  async getLogo(userId: string, id: string): Promise<FetchedLogo> {
    const payee = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Payee)
        .createQueryBuilder("payee")
        // The bytes are `select: false`, so they have to be asked for.
        .addSelect(["payee.logoData", "payee.logoContentType"])
        .where("payee.id = :id", { id })
        .andWhere("payee.user_id = :userId", { userId })
        .getOne(),
    );

    if (!payee) {
      throw new NotFoundException(
        tr("errors.payees.notFound", `Payee with ID ${id} not found`, { id }),
      );
    }

    if (!payee.hasLogo || !payee.logoData) {
      throw new NotFoundException(
        tr("errors.payees.logoNotFound", "No logo available for this payee"),
      );
    }

    return {
      data: payee.logoData,
      contentType: payee.logoContentType || "image/png",
    };
  }

  /**
   * Re-fetch the favicon for the payee's current website. A payee with no
   * website has nothing to resolve, so its cached icon is cleared rather than
   * left behind an address that no longer exists.
   */
  async refreshLogo(userId: string, id: string): Promise<Payee> {
    const payee = await this.findOne(userId, id);
    const logo = payee.website
      ? await this.faviconService.fetchFavicon(payee.website)
      : null;

    await withScopedDb(this.dataSource, (m) =>
      m.update(Payee, { id, userId }, brandLogoColumns(logo)),
    );

    return this.findOne(userId, id);
  }

  async search(
    userId: string,
    query: string,
    limit: number = 10,
  ): Promise<Payee[]> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(Payee).find({
        where: {
          userId,
          isActive: true,
          name: Like(`%${escapeLikeWildcards(query)}%`),
        },
        relations: ["defaultCategory"],
        order: { name: "ASC" },
        take: limit,
      }),
    );
  }

  async autocomplete(userId: string, query: string): Promise<Payee[]> {
    // Return active payees that start with the query (for autocomplete)
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(Payee).find({
        where: {
          userId,
          isActive: true,
          name: Like(`${escapeLikeWildcards(query)}%`),
        },
        relations: ["defaultCategory"],
        order: { name: "ASC" },
        take: 10,
      }),
    );
  }

  async findByName(userId: string, name: string): Promise<Payee | null> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(Payee).findOne({
        where: { userId, name },
        relations: ["defaultCategory"],
      }),
    );
  }

  /**
   * Find an inactive payee by name (case-insensitive).
   * Used to check if a typed payee name matches a deactivated payee.
   */
  async findInactiveByName(
    userId: string,
    name: string,
  ): Promise<Payee | null> {
    return withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Payee)
        .createQueryBuilder("payee")
        .leftJoinAndSelect("payee.defaultCategory", "defaultCategory")
        .where("payee.user_id = :userId", { userId })
        .andWhere("payee.is_active = false")
        .andWhere("LOWER(payee.name) = LOWER(:name)", { name })
        .getOne(),
    );
  }

  /**
   * Resolve a free-text payee name (as typed by a user or proposed by the AI
   * Assistant / MCP server) to an existing payee so a new transaction can link
   * to the payee record -- and inherit its default category -- instead of
   * storing a detached name. Resolution is tiered, most-specific first:
   *   1. exact name match (case-insensitive),
   *   2. alias pattern match (the same matching the importer uses),
   *   3. punctuation-insensitive match: normalize both sides (drop apostrophes,
   *      fold other punctuation/whitespace) so "Zehrs" resolves to
   *      "Zehr's Supermarket" and "Buon Gusto" to "Buon Gusto Restaurant".
   *      Prefer a single payee whose normalized name equals the input, else a
   *      single payee that contains it; anything ambiguous returns null.
   * Returns null when nothing matches so the caller can offer to create one.
   */
  async resolveByName(userId: string, name: string): Promise<Payee | null> {
    const trimmed = name.trim();
    if (!trimmed) {
      return null;
    }

    const byName = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Payee)
        .createQueryBuilder("payee")
        .leftJoinAndSelect("payee.defaultCategory", "defaultCategory")
        .where("payee.user_id = :userId", { userId })
        .andWhere("LOWER(payee.name) = LOWER(:name)", { name: trimmed })
        .getOne(),
    );
    if (byName) {
      return byName;
    }

    const byAlias = await this.findPayeeByAlias(userId, trimmed);
    if (byAlias) {
      return byAlias;
    }

    // Require a few significant characters so a 1-2 char term can't auto-link.
    const normalizedInput = normalizePayeeName(trimmed);
    if (normalizedInput.length < 3) {
      return null;
    }

    // Normalize in JS over the user's active payees (the exact + alias tiers
    // already handled the common cases) so apostrophes and other punctuation
    // never block a match regardless of how the database collates them.
    const activePayees = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Payee).find({
        where: { userId, isActive: true },
        relations: ["defaultCategory"],
      }),
    );
    const containing = activePayees.filter((payee) =>
      normalizePayeeName(payee.name).includes(normalizedInput),
    );
    const exactNormalized = containing.filter(
      (payee) => normalizePayeeName(payee.name) === normalizedInput,
    );
    if (exactNormalized.length === 1) {
      return exactNormalized[0];
    }
    return containing.length === 1 ? containing[0] : null;
  }

  async findOrCreate(
    userId: string,
    name: string,
    defaultCategoryId?: string,
  ): Promise<Payee> {
    // Try to find existing payee by name
    let payee = await this.findByName(userId, name);

    if (!payee) {
      // Create new payee if it doesn't exist
      payee = await this.create(userId, {
        name,
        defaultCategoryId,
      });
    }

    return payee;
  }

  async previewCategoryImpact(userId: string, id: string, dto: UpdatePayeeDto) {
    await this.findOne(userId, id);
    return withScopedDb(this.dataSource, async (m) => {
      const edit = await preparePayeeCategoryEdit(m, userId, id, dto);
      return {
        ...edit.preview,
        categoryId: edit.categoryId,
        mode: edit.mode,
        transactionsCategorized: edit.preview.transactionIds.length,
      };
    });
  }

  async update(
    userId: string,
    id: string,
    updatePayeeDto: UpdatePayeeDto,
  ): Promise<
    Payee & {
      aliasCount: number;
      transactionCount: number;
      transactionsCategorized: number;
    }
  > {
    const payee = await this.findOne(userId, id);
    let recordedAccrualHistory = false;
    let beforeData = {
      name: payee.name,
      notes: payee.notes,
      website: payee.website,
      address: payee.address,
      email: payee.email,
      phone: payee.phone,
      defaultCategoryId: payee.defaultCategoryId,
      isActive: payee.isActive,
    };

    // Check for name conflicts if name is being updated
    if (updatePayeeDto.name && updatePayeeDto.name !== payee.name) {
      const existing = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Payee).findOne({
          where: {
            userId,
            name: updatePayeeDto.name,
          },
        }),
      );

      if (existing) {
        throw new ConflictException(
          tr(
            "errors.payees.nameConflict",
            `Payee with name "${updatePayeeDto.name}" already exists`,
            { name: updatePayeeDto.name },
          ),
        );
      }
    }

    // SECURITY: Explicit property mapping instead of Object.assign to prevent
    // mass assignment. We persist with a column-level update (not save() on the
    // loaded entity) so the default_category_id FK is written from the scalar.
    // Saving the loaded entity is unsafe here: its defaultCategory relation is
    // hydrated, and TypeORM derives the FK from that relation -- so changing
    // only the scalar (or nulling the relation) makes save() clobber the FK,
    // which silently wiped the default category on an unchanged re-save.
    const updateFields: Partial<Payee> = {};
    if (updatePayeeDto.name !== undefined)
      updateFields.name = updatePayeeDto.name;
    if (updatePayeeDto.defaultCategoryId !== undefined)
      updateFields.defaultCategoryId = updatePayeeDto.defaultCategoryId;
    if (updatePayeeDto.notes !== undefined)
      updateFields.notes = updatePayeeDto.notes;
    if (updatePayeeDto.website !== undefined) {
      // "" is what the form sends for an address the user emptied, and
      // `normalizeWebsite` reads it as "clear it".
      const website = normalizeWebsite(updatePayeeDto.website) ?? null;
      updateFields.website = website;
      // Re-resolve the icon only when the address actually moved. The form
      // resends the current website on every save, and a re-fetch that failed
      // would clear a perfectly good cached icon; clearing the address clears
      // the icon with it. The fetch stays outside the transaction below.
      if (website !== payee.website) {
        const logo = website
          ? await this.faviconService.fetchFavicon(website)
          : null;
        Object.assign(updateFields, brandLogoColumns(logo));
      }
    }
    if (updatePayeeDto.email !== undefined)
      updateFields.email = normalizeContactField(updatePayeeDto.email) ?? null;
    if (updatePayeeDto.phone !== undefined) {
      const phone = normalizeContactField(updatePayeeDto.phone) ?? null;
      // A resent value is not an edit. The form sends every field on every
      // save, so keying the check off the field being PRESENT would re-run it
      // over a value already on the row -- and a row written before phones
      // were normalized holds one this build refuses, so renaming such a payee
      // would fail on a number the user never touched. Only a value that
      // actually moved is normalized; the stored one is left exactly as it is.
      updateFields.phone =
        phone !== null && phone !== payee.phone
          ? normalizePhoneOrThrow(
              phone,
              await resolveUserPhoneRegion(this.dataSource, userId),
            )
          : phone;
    }
    if (updatePayeeDto.address !== undefined)
      updateFields.address =
        normalizeContactField(updatePayeeDto.address) ?? null;
    if (updatePayeeDto.isActive !== undefined)
      updateFields.isActive = updatePayeeDto.isActive;

    const applyMode = updatePayeeDto.applyCategoryToTransactions ?? "none";

    // Save the payee and cascade the name change to existing transactions and
    // scheduled transactions atomically, so a partial failure cannot leave the
    // denormalised payeeName snapshots out of sync with the payee record. The
    // optional category backfill runs in the same transaction so the payee
    // default and its transactions can never drift apart on a partial failure.
    const transactionsCategorized = await withScopedDb(
      this.dataSource,
      async (m) => {
        const relationshipBefore = await beginPayeeRelationshipHistory(
          m,
          userId,
          id,
        );
        const livePayee = await m.findOne(Payee, { where: { id, userId } });
        if (!livePayee) throw accrualErrors.missing();
        const changedName =
          updateFields.name !== undefined &&
          updateFields.name !== livePayee.name;
        beforeData = {
          name: livePayee.name,
          notes: livePayee.notes,
          website: livePayee.website,
          address: livePayee.address,
          email: livePayee.email,
          phone: livePayee.phone,
          defaultCategoryId: livePayee.defaultCategoryId,
          isActive: livePayee.isActive,
        };

        const categoryEdit =
          applyMode !== "none" ||
          updatePayeeDto.accrualImpactFingerprint !== undefined
            ? await preparePayeeCategoryEdit(m, userId, id, updatePayeeDto)
            : undefined;
        if (categoryEdit)
          verifyBulkAccrualEdit(
            categoryEdit.preview,
            updatePayeeDto.accrualImpactFingerprint,
          );
        const sources =
          categoryEdit?.sources ??
          (changedName ? await lockPayeeSources(m, userId, [id]) : []);
        if (Object.keys(updateFields).length > 0) {
          await m.update(Payee, { id, userId }, updateFields);
        }

        if (changedName) {
          await updatePayeeSourceMetadata(m, userId, sources, id, {
            payeeName: updatePayeeDto.name!,
          });
          await m.update(
            ScheduledTransaction,
            { payeeId: id, userId },
            { payeeName: updatePayeeDto.name },
          );
        }

        const categorized = categoryEdit
          ? await applyPayeeCategoryEdit(m, userId, id, categoryEdit)
          : 0;
        if (relationshipBefore) {
          await recordRelationshipHistory(m, userId, relationshipBefore);
          recordedAccrualHistory = true;
        }
        return categorized;
      },
    );

    // Re-fetch with relations and computed counts so the frontend has complete data
    const refreshed = await this.findOne(userId, id);
    const { aliasCount, transactionCount } = await withScopedDb(
      this.dataSource,
      async (m) => ({
        aliasCount: await m.getRepository(PayeeAlias).count({
          where: { payeeId: id },
        }),
        transactionCount: await m.getRepository(Transaction).count({
          where: { payeeId: id, userId },
        }),
      }),
    );
    if (!recordedAccrualHistory)
      this.actionHistoryService.record(userId, {
        entityType: "payee",
        entityId: id,
        action: "update",
        beforeData,
        afterData: {
          name: refreshed.name,
          notes: refreshed.notes,
          website: refreshed.website,
          address: refreshed.address,
          email: refreshed.email,
          phone: refreshed.phone,
          defaultCategoryId: refreshed.defaultCategoryId,
          isActive: refreshed.isActive,
        },
        description: `Updated payee "${refreshed.name}"`,
        descriptionKey: "updatedPayee",
        descriptionParams: { name: refreshed.name },
      });
    return {
      ...refreshed,
      aliasCount,
      transactionCount,
      transactionsCategorized,
    };
  }

  async previewRemoval(userId: string, id: string) {
    await this.findOne(userId, id);
    return withScopedDb(this.dataSource, async (m) => {
      const edit = await preparePayeeRemoval(m, userId, id);
      return { ...edit.preview, scheduledReferences: edit.scheduled.length };
    });
  }

  async remove(
    userId: string,
    id: string,
    accrualImpactFingerprint?: string,
  ): Promise<void> {
    await this.findOne(userId, id);
    const payee = await withScopedDb(this.dataSource, (m) =>
      removePayeeWithAccruals(m, userId, id, accrualImpactFingerprint),
    );
    if (payee.relationshipRecorded) return;
    // Undo re-inserts exactly the columns this snapshot carries, so a field
    // missing from it does not come back -- the same reason `update` snapshots
    // the contact fields on both sides.
    const beforeData = {
      id: payee.id,
      name: payee.name,
      notes: payee.notes,
      website: payee.website,
      address: payee.address,
      email: payee.email,
      phone: payee.phone,
      defaultCategoryId: payee.defaultCategoryId,
      isActive: payee.isActive,
    };
    this.actionHistoryService.record(userId, {
      entityType: "payee",
      entityId: id,
      action: "delete",
      beforeData,
      description: `Deleted payee "${beforeData.name}"`,
      descriptionKey: "deletedPayee",
      descriptionParams: { name: beforeData.name },
    });
  }

  async getMostUsed(userId: string, limit: number = 10): Promise<Payee[]> {
    // Single query: join defaultCategory + aggregate transaction count, avoiding two-step fetch
    // Only return active payees for dropdown use
    return withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Payee)
        .createQueryBuilder("payee")
        .leftJoinAndSelect("payee.defaultCategory", "defaultCategory")
        .leftJoin(
          "transactions",
          "transaction",
          "transaction.payee_id = payee.id AND transaction.user_id = :userId",
          { userId },
        )
        .where("payee.user_id = :userId", { userId })
        .andWhere("payee.is_active = true")
        .groupBy("payee.id")
        .addGroupBy("defaultCategory.id")
        .orderBy("COUNT(transaction.id)", "DESC")
        .limit(limit)
        .getMany(),
    );
  }

  async getRecentlyUsed(userId: string, limit: number = 10): Promise<Payee[]> {
    // Single query: join defaultCategory + aggregate most recent date, avoiding two-step fetch
    // Only return active payees for dropdown use
    return withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Payee)
        .createQueryBuilder("payee")
        .leftJoinAndSelect("payee.defaultCategory", "defaultCategory")
        .leftJoin(
          "transactions",
          "transaction",
          "transaction.payee_id = payee.id AND transaction.user_id = :userId",
          { userId },
        )
        .where("payee.user_id = :userId", { userId })
        .andWhere("payee.is_active = true")
        .groupBy("payee.id")
        .addGroupBy("defaultCategory.id")
        .orderBy("MAX(transaction.transaction_date)", "DESC")
        .limit(limit)
        .getMany(),
    );
  }

  async getSummary(userId: string) {
    return withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(Payee);
      const totalPayees = await repo.count({
        where: { userId },
      });

      const payeesWithCategory = await repo.count({
        where: {
          userId,
          defaultCategoryId: Not(IsNull()),
        },
      });

      const activePayees = await repo.count({
        where: { userId, isActive: true },
      });

      const inactivePayees = totalPayees - activePayees;

      return {
        totalPayees,
        payeesWithCategory,
        payeesWithoutCategory: totalPayees - payeesWithCategory,
        activePayees,
        inactivePayees,
      };
    });
  }

  async findByCategory(userId: string, categoryId: string): Promise<Payee[]> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(Payee).find({
        where: {
          userId,
          defaultCategoryId: categoryId,
        },
        relations: ["defaultCategory"],
        order: { name: "ASC" },
      }),
    );
  }

  /**
   * Preview which payees would be deactivated based on the given criteria.
   * Returns payees with fewer than maxTransactions and last used before the cutoff date.
   */
  async previewDeactivation(
    userId: string,
    maxTransactions: number,
    monthsUnused: number,
  ): Promise<
    Array<{
      payeeId: string;
      payeeName: string;
      transactionCount: number;
      lastUsedDate: string | null;
      defaultCategoryName: string | null;
    }>
  > {
    // Calculate the cutoff date
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - monthsUnused);
    const cutoffDateStr = cutoffDate.toISOString().split("T")[0];

    // Get active payees with their transaction counts and last used dates
    const results = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Payee)
        .createQueryBuilder("payee")
        .leftJoinAndSelect("payee.defaultCategory", "defaultCategory")
        .leftJoin(
          "transactions",
          "t",
          "t.payee_id = payee.id AND t.user_id = :userId",
          { userId },
        )
        .where("payee.user_id = :userId", { userId })
        .andWhere("payee.is_active = true")
        .groupBy("payee.id")
        .addGroupBy("defaultCategory.id")
        .having("COUNT(t.id) <= :maxTransactions", { maxTransactions })
        .andHaving(
          "(MAX(t.transaction_date) IS NULL OR MAX(t.transaction_date) < :cutoffDate)",
          { cutoffDate: cutoffDateStr },
        )
        .select([
          "payee.id as payee_id",
          "payee.name as payee_name",
          "COUNT(t.id) as transaction_count",
          "MAX(t.transaction_date) as last_used_date",
          "defaultCategory.name as default_category_name",
        ])
        .orderBy("payee.name", "ASC")
        .getRawMany(),
    );

    return results.map((row) => ({
      payeeId: row.payee_id,
      payeeName: row.payee_name,
      transactionCount: parseInt(row.transaction_count || "0", 10),
      lastUsedDate: row.last_used_date || null,
      defaultCategoryName: row.default_category_name || null,
    }));
  }

  /**
   * Bulk deactivate payees by IDs.
   */
  async deactivatePayees(
    userId: string,
    payeeIds: string[],
  ): Promise<{ deactivated: number }> {
    if (payeeIds.length === 0) {
      return { deactivated: 0 };
    }

    const uniqueIds = [...new Set(payeeIds)];
    return withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(Payee);
      const payees = await repo.find({
        where: { id: In(uniqueIds), userId, isActive: true },
      });

      const toSave: Payee[] = [];
      for (const payee of payees) {
        payee.isActive = false;
        toSave.push(payee);
      }

      if (toSave.length > 0) {
        await repo.save(toSave);
      }

      return { deactivated: toSave.length };
    });
  }

  /**
   * Reactivate a single payee by ID.
   */
  async reactivatePayee(userId: string, id: string): Promise<Payee> {
    const payee = await this.findOne(userId, id);
    if (payee.isActive) {
      return payee;
    }
    payee.isActive = true;
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(Payee).save(payee),
    );
  }

  /**
   * Calculate suggested category assignments for payees based on transaction history.
   * @param userId The user ID
   * @param minTransactions Minimum number of transactions a payee must have
   * @param minPercentage Minimum percentage (0-100) a category must appear to be suggested
   * @param onlyWithoutCategory If true, only consider payees without a default category
   */
  async calculateCategorySuggestions(
    userId: string,
    minTransactions: number,
    minPercentage: number,
    onlyWithoutCategory: boolean = true,
  ): Promise<
    Array<{
      payeeId: string;
      payeeName: string;
      currentCategoryId: string | null;
      currentCategoryName: string | null;
      suggestedCategoryId: string;
      suggestedCategoryName: string;
      transactionCount: number;
      categoryCount: number;
      percentage: number;
      uncategorizedCount: number;
    }>
  > {
    const {
      categoryUsage,
      totalCounts,
      uncategorizedCountMap,
      payeesWithCategories,
    } = await withScopedDb(this.dataSource, async (m) => {
      // Get category usage statistics per payee
      // This query counts how many times each category is used for each payee
      const query = m
        .getRepository(Payee)
        .createQueryBuilder("payee")
        .leftJoin(
          "transactions",
          "t",
          "t.payee_id = payee.id AND t.is_transfer = false",
        )
        .leftJoin("categories", "c", "c.id = t.category_id")
        .where("payee.user_id = :userId", { userId })
        .andWhere("t.category_id IS NOT NULL")
        .groupBy("payee.id")
        .addGroupBy("payee.name")
        .addGroupBy("payee.default_category_id")
        .addGroupBy("t.category_id")
        .addGroupBy("c.name")
        .select([
          "payee.id as payee_id",
          "payee.name as payee_name",
          "payee.default_category_id as current_category_id",
          "t.category_id as category_id",
          "c.name as category_name",
          "COUNT(t.id) as category_count",
        ])
        .having("COUNT(t.id) > 0");

      if (onlyWithoutCategory) {
        query.andWhere("payee.default_category_id IS NULL");
      }

      // Get total transaction count per payee
      const totalCountsQuery = m
        .getRepository(Payee)
        .createQueryBuilder("payee")
        .leftJoin(
          "transactions",
          "t",
          "t.payee_id = payee.id AND t.is_transfer = false",
        )
        .where("payee.user_id = :userId", { userId })
        .andWhere("t.category_id IS NOT NULL")
        .groupBy("payee.id")
        .select(["payee.id as payee_id", "COUNT(t.id) as total_count"])
        .having("COUNT(t.id) >= :minTransactions", { minTransactions });

      if (onlyWithoutCategory) {
        totalCountsQuery.andWhere("payee.default_category_id IS NULL");
      }

      return {
        categoryUsage: await query.getRawMany(),
        totalCounts: await totalCountsQuery.getRawMany(),
        // Per-payee count of transactions a default-category backfill would
        // touch, surfaced per suggestion so the UI can offer the optional
        // backfill.
        uncategorizedCountMap: await countUncategorizedTransactionsByPayee(
          m,
          userId,
        ),
        // Get current category names for payees that have one
        payeesWithCategories: await m.getRepository(Payee).find({
          where: { userId },
          relations: ["defaultCategory"],
        }),
      };
    });

    const totalCountMap = toCountMap(totalCounts, {
      keyField: "payee_id",
      countField: "total_count",
    });

    const currentCategoryMap = new Map<
      string,
      { id: string | null; name: string | null }
    >();
    for (const payee of payeesWithCategories) {
      currentCategoryMap.set(payee.id, {
        id: payee.defaultCategoryId,
        name: payee.defaultCategory?.name || null,
      });
    }

    // Find the most used category for each payee that meets the threshold
    const suggestions: Array<{
      payeeId: string;
      payeeName: string;
      currentCategoryId: string | null;
      currentCategoryName: string | null;
      suggestedCategoryId: string;
      suggestedCategoryName: string;
      transactionCount: number;
      categoryCount: number;
      percentage: number;
      uncategorizedCount: number;
    }> = [];

    // Group category usage by payee
    const payeeCategories = new Map<
      string,
      Array<{
        payeeName: string;
        categoryId: string;
        categoryName: string;
        count: number;
      }>
    >();

    for (const row of categoryUsage) {
      const payeeId = row.payee_id;
      if (!payeeCategories.has(payeeId)) {
        payeeCategories.set(payeeId, []);
      }
      payeeCategories.get(payeeId)!.push({
        payeeName: row.payee_name,
        categoryId: row.category_id,
        categoryName: row.category_name,
        count: parseInt(row.category_count, 10),
      });
    }

    // For each payee that meets minimum transaction threshold, find best category
    for (const [payeeId, categories] of payeeCategories) {
      const totalCount = totalCountMap.get(payeeId);
      if (!totalCount || totalCount < minTransactions) continue;

      // Sort categories by count (descending) and find the top one
      categories.sort((a, b) => b.count - a.count);
      const topCategory = categories[0];
      const percentage = (topCategory.count / totalCount) * 100;

      // Check if meets percentage threshold
      if (percentage >= minPercentage) {
        const current = currentCategoryMap.get(payeeId);
        // Skip if already has this category assigned
        if (current?.id === topCategory.categoryId) continue;

        suggestions.push({
          payeeId,
          payeeName: topCategory.payeeName,
          currentCategoryId: current?.id || null,
          currentCategoryName: current?.name || null,
          suggestedCategoryId: topCategory.categoryId,
          suggestedCategoryName: topCategory.categoryName,
          transactionCount: totalCount,
          categoryCount: topCategory.count,
          percentage: Math.round(percentage * 10) / 10,
          uncategorizedCount: uncategorizedCountMap.get(payeeId) ?? 0,
        });
      }
    }

    // Sort by payee name
    suggestions.sort((a, b) => a.payeeName.localeCompare(b.payeeName));

    return suggestions;
  }

  /**
   * Apply category suggestions to payees (bulk update). When an assignment opts
   * into `backfillTransactions`, that payee's existing uncategorized
   * transactions also receive the chosen category (manual categorizations,
   * transfers, and split parents are left untouched). Setting the default
   * category and backfilling span two tables, so the whole batch runs in one
   * transaction.
   */
  async previewCategorySuggestionsImpact(
    userId: string,
    assignments: Array<{
      payeeId: string;
      categoryId: string;
      backfillTransactions?: boolean;
    }>,
  ) {
    return withScopedDb(
      this.dataSource,
      async (m) =>
        (await prepareSuggestionCategoryBatch(m, userId, assignments)).preview,
    );
  }

  async applyCategorySuggestions(
    userId: string,
    assignments: Array<{
      payeeId: string;
      categoryId: string;
      backfillTransactions?: boolean;
    }>,
    accrualImpactFingerprint?: string,
  ): Promise<{ updated: number; transactionsBackfilled: number }> {
    // M24: Batch-verify all categoryIds belong to the user
    const uniqueCategoryIds = [
      ...new Set(assignments.map((a) => a.categoryId)),
    ];
    if (uniqueCategoryIds.length > 0) {
      const ownedCategories = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Category).find({
          where: { id: In(uniqueCategoryIds), userId },
          select: ["id"],
        }),
      );
      const ownedCategoryIds = new Set(ownedCategories.map((c) => c.id));
      const invalidIds = uniqueCategoryIds.filter(
        (id) => !ownedCategoryIds.has(id),
      );
      if (invalidIds.length > 0) {
        throw new BadRequestException(
          tr(
            "errors.payees.categoryIdsNotOwned",
            `Category IDs not found or not owned by user: ${invalidIds.join(", ")}`,
            { ids: invalidIds.join(", ") },
          ),
        );
      }
    }

    return withScopedDb(this.dataSource, async (m) => {
      const batch = await prepareSuggestionCategoryBatch(
        m,
        userId,
        assignments,
      );
      verifyBulkAccrualEdit(batch.preview, accrualImpactFingerprint);
      let transactionsBackfilled = 0;
      for (const plan of batch.plans) {
        await m.update(
          Payee,
          { id: plan.payeeId, userId },
          { defaultCategoryId: plan.edit.categoryId },
        );
        transactionsBackfilled += await applyPayeeCategoryEdit(
          m,
          userId,
          plan.payeeId,
          plan.edit,
        );
      }
      return { updated: batch.plans.length, transactionsBackfilled };
    });
  }

  // ===== Alias Methods =====

  /**
   * Get all aliases for a specific payee.
   */
  async getAliases(userId: string, payeeId: string): Promise<PayeeAlias[]> {
    await this.findOne(userId, payeeId);
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(PayeeAlias).find({
        where: { payeeId, userId },
        order: { alias: "ASC" },
      }),
    );
  }

  /**
   * Get all aliases for the user (across all payees).
   */
  async getAllAliases(userId: string): Promise<PayeeAlias[]> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(PayeeAlias).find({
        where: { userId },
        relations: ["payee"],
        order: { alias: "ASC" },
      }),
    );
  }

  /**
   * Create a new alias for a payee.
   * Validates that the alias doesn't conflict with existing aliases.
   */
  async createAlias(
    userId: string,
    dto: CreatePayeeAliasDto,
  ): Promise<PayeeAlias> {
    // Verify the payee exists and belongs to the user
    await this.findOne(userId, dto.payeeId);

    const trimmedAlias = dto.alias.trim();
    if (!trimmedAlias) {
      throw new BadRequestException(
        tr("errors.payees.aliasEmpty", "Alias cannot be empty"),
      );
    }

    return withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(PayeeAlias);

      // Check for exact duplicate alias (case-insensitive)
      const existingExact = await repo
        .createQueryBuilder("alias")
        .where("alias.user_id = :userId", { userId })
        .andWhere("LOWER(alias.alias) = LOWER(:alias)", { alias: trimmedAlias })
        .leftJoinAndSelect("alias.payee", "payee")
        .getOne();

      if (existingExact) {
        throw new ConflictException(
          tr(
            "errors.payees.aliasDuplicate",
            `Alias "${trimmedAlias}" is already assigned to payee "${existingExact.payee?.name || "unknown"}"`,
            {
              alias: trimmedAlias,
              payeeName: existingExact.payee?.name || "unknown",
            },
          ),
        );
      }

      // Check for overlapping wildcard patterns
      const allAliases = await repo.find({
        where: { userId },
        relations: ["payee"],
      });

      for (const existing of allAliases) {
        // Check if the new alias would match any existing alias patterns
        if (matchesAliasPattern(trimmedAlias, existing.alias)) {
          throw new ConflictException(
            tr(
              "errors.payees.aliasOverlap",
              `Alias "${trimmedAlias}" overlaps with existing alias "${existing.alias}" on payee "${existing.payee?.name || "unknown"}". Consider modifying one of them.`,
              {
                alias: trimmedAlias,
                existingAlias: existing.alias,
                payeeName: existing.payee?.name || "unknown",
              },
            ),
          );
        }
        // Check if any existing alias pattern would match the new one
        if (matchesAliasPattern(existing.alias, trimmedAlias)) {
          throw new ConflictException(
            tr(
              "errors.payees.aliasOverlap",
              `Alias "${trimmedAlias}" overlaps with existing alias "${existing.alias}" on payee "${existing.payee?.name || "unknown"}". Consider modifying one of them.`,
              {
                alias: trimmedAlias,
                existingAlias: existing.alias,
                payeeName: existing.payee?.name || "unknown",
              },
            ),
          );
        }
      }

      const alias = repo.create({
        payeeId: dto.payeeId,
        userId,
        alias: trimmedAlias,
      });

      return repo.save(alias);
    });
  }

  /**
   * Delete an alias by ID.
   */
  async removeAlias(userId: string, aliasId: string): Promise<void> {
    await withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(PayeeAlias);
      const alias = await repo.findOne({
        where: { id: aliasId, userId },
      });

      if (!alias) {
        throw new NotFoundException(
          tr(
            "errors.payees.aliasNotFound",
            `Alias with ID ${aliasId} not found`,
            { id: aliasId },
          ),
        );
      }

      await repo.remove(alias);
    });
  }

  /**
   * Find a payee by matching an imported name against aliases.
   * Returns the payee if a matching alias is found, null otherwise.
   * Case-insensitive, supports * wildcards in alias patterns.
   */
  async findPayeeByAlias(
    userId: string,
    importedName: string,
  ): Promise<Payee | null> {
    // Load all aliases for this user and check for matches
    const aliases = await withScopedDb(this.dataSource, (m) =>
      m.find(PayeeAlias, {
        where: { userId },
        relations: ["payee", "payee.defaultCategory"],
      }),
    );

    for (const alias of aliases) {
      if (matchesAliasPattern(importedName, alias.alias)) {
        return alias.payee ?? null;
      }
    }

    return null;
  }

  /**
   * Merge one payee into another:
   * 1. Reassign all transactions from source to target payee
   * 2. Optionally add the source payee name as an alias on the target
   * 3. Delete the source payee
   *
   * The whole merge runs in one transaction for atomicity.
   */
  async mergePayees(
    userId: string,
    dto: MergePayeeDto,
  ): Promise<{
    transactionsMigrated: number;
    aliasAdded: boolean;
    sourcePayeeDeleted: boolean;
  }> {
    const { targetPayeeId, sourcePayeeId, addAsAlias = true } = dto;

    if (targetPayeeId === sourcePayeeId) {
      throw new BadRequestException(
        tr("errors.payees.mergeSelf", "Cannot merge a payee into itself"),
      );
    }

    // Verify both payees exist and belong to the user
    const targetPayee = await this.findOne(userId, targetPayeeId);
    const sourcePayee = await this.findOne(userId, sourcePayeeId);

    return withScopedDb(this.dataSource, async (m) => {
      const history = await beginTaxonomyOperation(m, userId, "payee", [
        sourcePayeeId,
        targetPayeeId,
      ]);
      const liveTarget = history
        ? await m.findOne(Payee, { where: { id: targetPayeeId, userId } })
        : targetPayee;
      const liveSource = history
        ? await m.findOne(Payee, { where: { id: sourcePayeeId, userId } })
        : sourcePayee;
      if (!liveTarget || !liveSource) throw accrualErrors.conflict();
      const sources = await lockPayeeSources(m, userId, [sourcePayeeId]);
      // 1. Reassign the locked source set and maintain linked accrual metadata.
      const transactionsMigrated = await updatePayeeSourceMetadata(
        m,
        userId,
        sources,
        sourcePayeeId,
        { payeeId: targetPayeeId, payeeName: liveTarget.name },
      );

      // Also reassign scheduled transactions
      await m.update(
        ScheduledTransaction,
        { payeeId: sourcePayeeId, userId },
        { payeeId: targetPayeeId, payeeName: liveTarget.name },
      );

      // 2. Optionally add source payee name as alias on target
      let aliasAdded = false;
      if (addAsAlias) {
        // Check if the alias already exists
        const existingAlias = await m
          .createQueryBuilder(PayeeAlias, "alias")
          .where("alias.user_id = :userId", { userId })
          .andWhere("LOWER(alias.alias) = LOWER(:alias)", {
            alias: liveSource.name,
          })
          .getOne();

        if (!existingAlias) {
          const newAlias = m.create(PayeeAlias, {
            payeeId: targetPayeeId,
            userId,
            alias: liveSource.name,
          });
          // The existence check above and this insert are not atomic: a
          // concurrent merge can create the same alias in between, so guard the
          // insert against the UNIQUE(user_id, LOWER(alias)) constraint. The
          // alias is best-effort; a duplicate must not roll back the merge
          // (transaction/scheduled-transaction reassignment) with an opaque 409.
          aliasAdded = await insertPayeeAliasIgnoringDuplicate(
            m,
            newAlias,
            "merge_payee_alias",
          );
        }
      }

      // 3. Move any aliases from source payee to target payee
      await m.update(
        PayeeAlias,
        { payeeId: sourcePayeeId, userId },
        { payeeId: targetPayeeId },
      );

      // 4. Delete the source payee
      await m.remove(Payee, liveSource);
      await recordTaxonomyOperation(m, userId, history);

      return {
        transactionsMigrated,
        aliasAdded,
        sourcePayeeDeleted: true,
      };
    });
  }
}
