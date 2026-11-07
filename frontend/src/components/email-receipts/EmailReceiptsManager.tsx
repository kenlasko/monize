'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { EnvelopeIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { BulkConfirmDialog } from '@/components/email-receipts/BulkConfirmDialog';
import { LinkedDraftDialog } from '@/components/email-receipts/LinkedDraftDialog';
import { LinkedProfilesHint } from '@/components/email-receipts/LinkedProfilesHint';
import { EmailReceiptDetailDialog } from '@/components/email-receipts/EmailReceiptDetailDialog';
import { ReceiptBulkBar } from '@/components/email-receipts/ReceiptBulkBar';
import { ReceiptListTable } from '@/components/email-receipts/ReceiptListTable';
import { ReceiptSearchBar } from '@/components/email-receipts/ReceiptSearchBar';
import { RetryFailedEmailsButton } from '@/components/email-receipts/RetryFailedEmailsButton';
import { SenderDomainCloud } from '@/components/email-receipts/SenderDomainCloud';
import { ParserEditorDialog } from '@/components/email-receipts/ParserEditorDialog';
import { RecognizeWithAiDialog } from '@/components/email-receipts/RecognizeWithAiDialog';
import { useParserDraftWithAi } from '@/components/email-receipts/useParserDraftWithAi';
import { useProfileDiscardOffer } from '@/components/email-receipts/useProfileDiscardOffer';
import { useReceiptBulkActions } from '@/components/email-receipts/useReceiptBulkActions';
import { useReceiptBulkProcessing } from '@/components/email-receipts/useReceiptBulkProcessing';
import { useReceiptNarrowing } from '@/components/email-receipts/useReceiptNarrowing';
import { useReceiptSearch } from '@/components/email-receipts/useReceiptSearch';
import { Button, buttonClassName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListBottomPager } from '@/components/ui/ListBottomPager';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import type { RowAction } from '@/components/ui/row-actions';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReceiptParserLookups } from '@/hooks/useReceiptParserLookups';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import {
  canDraftParser,
  canLinkTradeEmail,
  canRecognizeWithAi,
  canReprocessReceipt,
  distinctSenderDomains,
  draftBlock,
  senderDomainCounts,
  isReceiptActionable,
  normalizeDomainFilter,
  senderDomain,
} from '@/lib/email-receipts-format';
import { getErrorMessage } from '@/lib/errors';
import { isUuid } from '@/lib/uuid';
import { leadActionKey, orderActionsForCard, type ReceiptActionKey } from '@/lib/receipt-row-actions';
import { createLogger } from '@/lib/logger';
import { isReceiptSearchActive, receiptSearchKey } from '@/lib/receipt-search';
import { deselects, isBulkApprovable, isTradeProposal, type Deselection } from '@/lib/receipt-selection';
import {
  EMAIL_RECEIPT_STATUSES,
  type EmailReceiptBulkScope,
  type EmailReceiptDomainCount,
  type EmailReceiptListItem,
  type EmailReceiptSearch,
  type EmailReceiptStatus,
  type EmailReceiptStatusCounts,
} from '@/types/email-receipts';

const logger = createLogger('EmailReceipts');

/** Emails per page: the server's default limit, which the request leaves unsent, so only the offset is. */
const PAGE_SIZE = 50;

/** Sender domains the "Deselect by" menu lists for an "every email matching" selection (the biggest first, as the cloud orders them). */
const MAX_DOMAIN_OPTIONS = 8;

const FILTERS = ['all', ...EMAIL_RECEIPT_STATUSES] as const;
type ReceiptFilter = (typeof FILTERS)[number];

/** States from which the detail dialog can link the email to a transaction. */
const LINKABLE_STATUSES: readonly EmailReceiptStatus[] = ['ambiguous', 'unmatched', 'no_parser', 'parse_failed'];

/** A row's actions in their resting order, before the card's lead action is moved to the front. */
const ROW_ACTION_KEYS: readonly { key: ReceiptActionKey }[] = [
  { key: 'view' },
  { key: 'approve' },
  { key: 'draftParser' },
  { key: 'createParser' },
  { key: 'link' },
  { key: 'recognizeAi' },
  { key: 'recognizeTradeAi' },
  { key: 'reprocess' },
  { key: 'ignore' },
  { key: 'delete' },
];

/**
 * The search goes to the server only when it narrows the list, and as one extra
 * argument, so a call without a search is the call it always was.
 */
function searchArgs(search: EmailReceiptSearch): readonly [EmailReceiptSearch] | readonly [] {
  return isReceiptSearchActive(search) ? [search] : [];
}

/** The list answers one set of filters (state, sender domain, `''` for all, and the search's key) and one page of it; `items === null` is a request that failed. */
interface LoadedList {
  filter: ReceiptFilter;
  domain: string;
  searchKey: string;
  page: number;
  items: EmailReceiptListItem[] | null;
}

/** How many emails match one set of filters, as the server counts them (the same answer the state buttons read). */
interface MatchingCount {
  filter: ReceiptFilter;
  domain: string;
  searchKey: string;
  total: number;
}

/** A count or domain list the server gave for one search; read only while that search is the one on screen. */
interface ForSearch<T> {
  searchKey: string;
  items: T;
}

/** Whether the user has a mailbox, as far as it is known: `none` is a loaded answer of "no mailbox". */
type MailboxState = { status: 'loading' } | { status: 'failed' } | { status: 'none' } | { status: 'ready' };

type Confirmation = { kind: 'ignore' | 'delete'; receipt: EmailReceiptListItem };

/** The sender domains counted within one state (`filter`), the answer for that state only. */
interface DomainCloudState {
  filter: ReceiptFilter;
  searchKey: string;
  items: EmailReceiptDomainCount[];
}

interface Notice {
  tone: 'success' | 'error';
  text: string;
  /** A place to go next, such as the parsers list a draft lands in. */
  link?: { href: string; label: string };
}

/**
 * The receipts page body: every stored order-confirmation email with its state
 * and the actions on it.
 *
 * A list belongs to the filters that asked for it (`LoadedList.filter`,
 * `.domain` and `.searchKey`; the counts and the domain lists carry the search
 * key too), so a slow answer for a filter the reader has left is never drawn
 * under the new one
 * and no action can be aimed at a row of the other list. `null` is loading or
 * failed, never an empty list; only a loaded, empty answer says "nothing here".
 * "Draft parser with AI" and "Recognize with AI" are the person's own request to
 * the assistant, offered whatever the mailbox's AI mode: the request is queued and
 * the chat is opened (or the request waits in the review inbox) rather than a
 * provider being called from here.
 *
 * Any number of rows can be selected. A selection of every row on the page can be
 * widened to every email matching the filter, which the server counts (`matching`);
 * a bulk delete or ignore then names the filter, not ids. A profile is drafted from
 * one to five emails of each of one to five senders (`draftBlock` says why it is off); a
 * selection over several senders is confirmed first, since it is for one transaction's linked emails.
 */
export function EmailReceiptsManager() {
  const t = useTranslations('emailReceipts.receipts');
  const tc = useTranslations('common');
  const { formatNumber } = useNumberFormat();
  const { state: lookups, reload: reloadLookups } = useReceiptParserLookups();

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState<ReceiptFilter>('all');
  // The sender domain filter starts from `?domain=` and is written back to it;
  // a value that is no host name is no filter.
  const [domain, setDomain] = useState<string>(() => normalizeDomainFilter(searchParams.get('domain')));
  // The page of the list (1-based). It belongs to the filters: every handler that changes one returns to page 1.
  const [page, setPage] = useState(1);
  // The free-text search and date range. Its applied value is part of every request key below.
  const receiptSearch = useReceiptSearch();
  const search = receiptSearch.search;
  const searchKey = receiptSearch.key;
  // The sender domains with their counts for the filter; null while unknown or failed (the select then offers only "All" and the current one).
  const [domains, setDomains] = useState<ForSearch<EmailReceiptDomainCount[]> | null>(null);
  // The same counts within the state the reader is on, for every state but "All"; null while unknown or failed.
  const [cloud, setCloud] = useState<DomainCloudState | null>(null);
  // How many emails are in each state, printed on the filter buttons; null while unknown or failed (no number is shown then).
  const [counts, setCounts] = useState<ForSearch<EmailReceiptStatusCounts> | null>(null);
  const [loaded, setLoaded] = useState<LoadedList | null>(null);
  const [mailbox, setMailbox] = useState<MailboxState>({ status: 'loading' });
  // The emails ticked, by id, each as last seen. A tick outlives a change of state, sender or page, so
  // a person can pick emails of several senders; `selected` below refreshes the copies of the rows on screen.
  const [selectedRows, setSelectedRows] = useState<ReadonlyMap<string, EmailReceiptListItem>>(new Map());
  // How many emails match the filter (null while unknown or failed), and whether the selection is all of them (the count it was chosen with) rather than the ticked rows.
  const [matching, setMatching] = useState<MatchingCount | null>(null);
  const [allMatching, setAllMatching] = useState<number | null>(null);
  // A new search starts at the first page with nothing ticked, as a new domain does. The search applies
  // when the typed text has rested, not in a handler, so the reset happens as the new key is first rendered.
  const [seenSearchKey, setSeenSearchKey] = useState(searchKey);
  if (seenSearchKey !== searchKey) {
    setSeenSearchKey(searchKey);
    setPage(1);
    setSelectedRows(new Map());
    setAllMatching(null);
  }
  const [drafting, setDrafting] = useState(false);
  // A draft over several sender domains waits here for the person's confirmation.
  const [linkedDraftFor, setLinkedDraftFor] = useState<readonly EmailReceiptListItem[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // The detail dialog opens on `?email=<id>` (the review inbox links to one email); a value that is no id opens nothing.
  const [detailId, setDetailId] = useState<string | null>(() => {
    const requested = searchParams.get('email');
    return requested !== null && isUuid(requested) ? requested : null;
  });
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [parserFor, setParserFor] = useState<EmailReceiptListItem | null>(null);
  const [recognizeFor, setRecognizeFor] = useState<{ receipt: EmailReceiptListItem; asTrade: boolean } | null>(null);
  const startParserDraft = useParserDraftWithAi();

  // Only the newest request may write the list, and a reload after an action
  // asks for the filter the reader is on NOW, not the one the handler saw.
  const latestLoad = useRef(0);
  const latestDomains = useRef(0);
  const latestCloud = useRef(0);
  const latestCounts = useRef(0);
  const latestMatching = useRef(0);
  const currentFilters = useRef({ filter, domain, page, search });
  useEffect(() => {
    currentFilters.current = { filter, domain, page, search };
  }, [filter, domain, page, search]);

  // Each loader below runs from an effect: its state writes live in the inner `run`, so they happen after the request, not during the effect.
  const load = useCallback((forFilter: ReceiptFilter, forDomain: string, forPage: number, forSearch: EmailReceiptSearch) => {
    const run = async () => {
      const request = ++latestLoad.current;
      const forKey = receiptSearchKey(forSearch);
      const status = forFilter === 'all' ? undefined : forFilter;
      const sender = forDomain === '' ? undefined : forDomain;
      try {
        const items = await emailReceiptsApi.receipts.list(status, undefined, sender, (forPage - 1) * PAGE_SIZE, ...searchArgs(forSearch));
        if (request !== latestLoad.current) return;
        if (items.length === 0 && forPage > 1) {
          // The page no longer exists (its emails were deleted or left the filter): go to the last one that does.
          let lastPage = forPage - 1;
          try {
            const total = await emailReceiptsApi.receipts.countMatching(status, sender, ...searchArgs(forSearch));
            lastPage = Math.max(1, Math.min(lastPage, Math.ceil(total / PAGE_SIZE)));
          } catch (error) {
            logger.error(error);
          }
          if (request !== latestLoad.current) return;
          setPage(lastPage);
          return;
        }
        setLoaded({ filter: forFilter, domain: forDomain, searchKey: forKey, page: forPage, items });
      } catch (error) {
        if (request !== latestLoad.current) return;
        logger.error(error);
        setLoaded({ filter: forFilter, domain: forDomain, searchKey: forKey, page: forPage, items: null });
      }
    };
    return run();
  }, []);

  /** The domains the filter offers; a failed read leaves them unknown, never an empty list. */
  const loadDomains = useCallback((forSearch: EmailReceiptSearch) => {
    const run = async () => {
      const request = ++latestDomains.current;
      try {
        const found = isReceiptSearchActive(forSearch)
          ? await emailReceiptsApi.receipts.listDomains(undefined, forSearch)
          : await emailReceiptsApi.receipts.listDomains();
        if (request !== latestDomains.current) return;
        setDomains({ searchKey: receiptSearchKey(forSearch), items: found });
      } catch (error) {
        if (request !== latestDomains.current) return;
        logger.error(error);
        setDomains(null);
      }
    };
    return run();
  }, []);

  /** The sender domains of one state's emails; a failed read leaves them unknown. */
  const loadCloud = useCallback((forFilter: ReceiptFilter, forSearch: EmailReceiptSearch) => {
    const run = async () => {
      if (forFilter === 'all') return;
      const request = ++latestCloud.current;
      try {
        const items = await emailReceiptsApi.receipts.listDomains(forFilter, ...searchArgs(forSearch));
        if (request !== latestCloud.current) return;
        setCloud({ filter: forFilter, searchKey: receiptSearchKey(forSearch), items });
      } catch (error) {
        if (request !== latestCloud.current) return;
        logger.error(error);
        setCloud(null);
      }
    };
    return run();
  }, []);

  /** The per-state counts; a failed read leaves them unknown, never zero. */
  const loadCounts = useCallback((forSearch: EmailReceiptSearch) => {
    const run = async () => {
      const request = ++latestCounts.current;
      try {
        const found = await emailReceiptsApi.receipts.getStatusCounts(...searchArgs(forSearch));
        if (request !== latestCounts.current) return;
        setCounts({ searchKey: receiptSearchKey(forSearch), items: found });
      } catch (error) {
        if (request !== latestCounts.current) return;
        logger.error(error);
        setCounts(null);
      }
    };
    return run();
  }, []);

  /** How many emails match the filter; a failed read leaves it unknown, so no "select all N" is offered. */
  const loadMatching = useCallback((forFilter: ReceiptFilter, forDomain: string, forSearch: EmailReceiptSearch) => {
    const run = async () => {
      const request = ++latestMatching.current;
      try {
        const total = await emailReceiptsApi.receipts.countMatching(
          forFilter === 'all' ? undefined : forFilter,
          forDomain === '' ? undefined : forDomain,
          ...searchArgs(forSearch),
        );
        if (request !== latestMatching.current) return;
        setMatching({ filter: forFilter, domain: forDomain, searchKey: receiptSearchKey(forSearch), total });
      } catch (error) {
        if (request !== latestMatching.current) return;
        logger.error(error);
        setMatching(null);
      }
    };
    return run();
  }, []);

  // After a command or a change the list, the state counts and the domain counts are read again.
  const reload = useCallback(async () => {
    const now = currentFilters.current;
    void loadDomains(now.search);
    void loadCounts(now.search);
    void loadMatching(now.filter, now.domain, now.search);
    void loadCloud(now.filter, now.search);
    await load(now.filter, now.domain, now.page, now.search);
  }, [load, loadDomains, loadCounts, loadCloud, loadMatching]);
  // A profile made here that ignores or deletes its emails offers to do so to the stored ones it matches.
  const discardOffer = useProfileDiscardOffer(() => void reload());

  useEffect(() => {
    void load(filter, domain, page, search);
  }, [filter, domain, page, search, load]);

  // The total belongs to the filters alone, so turning a page does not count again.
  useEffect(() => {
    void loadMatching(filter, domain, search);
  }, [filter, domain, search, loadMatching]);

  useEffect(() => {
    void loadDomains(search);
    void loadCounts(search);
  }, [search, loadDomains, loadCounts]);

  useEffect(() => {
    void loadCloud(filter, search);
  }, [filter, search, loadCloud]);

  // What was taken out of an "every email matching" selection, and the number it leaves.
  const narrowBase = useMemo(
    () => ({ ...(filter === 'all' ? {} : { status: filter }), ...(domain === '' ? {} : { domain }), ...search }),
    [filter, domain, search],
  );
  const narrowing = useReceiptNarrowing({
    base: narrowBase,
    resetKey: searchKey,
    onEmpty: () => {
      setSelectedRows(new Map());
      setAllMatching(null);
    },
  });
  const resetNarrowing = narrowing.reset;

  const clearSelection = useCallback(() => {
    setSelectedRows(new Map());
    setAllMatching(null);
    resetNarrowing();
  }, [resetNarrowing]);

  // "Every email matching the filter" is defined by the filter, so a change of filter ends it; ticked rows stay.
  const leaveAllMatching = useCallback(() => {
    setAllMatching(null);
    resetNarrowing();
  }, [resetNarrowing]);

  // Ticked rows survive paging, and so does "every email matching the filter", which covers all pages.
  const changePage = (next: number) => {
    setPage(next);
  };

  const bulk = useReceiptBulkActions({ reload, onDone: clearSelection });
  const processing = useReceiptBulkProcessing({ reload, onDone: clearSelection });
  const locked = bulk.running || processing.running;

  /** Closes the detail dialog; an `?email=` that opened it leaves the URL, so a reload does not open it again. */
  const closeDetail = () => {
    setDetailId(null);
    if (!searchParams.has('email')) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete('email');
    const query = params.toString();
    router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false });
  };

  const changeDomain = (next: string) => {
    setDomain(next);
    setPage(1);
    leaveAllMatching();
    const params = new URLSearchParams(searchParams.toString());
    // Without a domain a legacy `/email-receipts?domain=` link would fall back to the Overview, so the tab is named.
    params.set('tab', 'emails');
    if (next === '') params.delete('domain');
    else params.set('domain', next);
    const query = params.toString();
    router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false });
  };

  useEffect(() => {
    let cancelled = false;
    emailReceiptsApi.mailbox
      .get()
      .then((found) => {
        if (cancelled) return;
        setMailbox(found ? { status: 'ready' } : { status: 'none' });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setMailbox({ status: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const categoryLabels = useMemo(
    () =>
      lookups.status === 'ready' ? new Map(lookups.lookups.categories.map((option) => [option.value, option.label])) : null,
    [lookups],
  );

  /** Runs one command on one email: busy while it runs, the list reloaded after it, the failure named. */
  const runCommand = async (receipt: EmailReceiptListItem, work: () => Promise<Notice | null>, failureText: string) => {
    setBusyId(receipt.id);
    setNotice(null);
    try {
      const result = await work();
      if (result) setNotice(result);
      await reload();
    } catch (error) {
      setNotice({ tone: 'error', text: getErrorMessage(error, failureText) });
      logger.error(error);
    } finally {
      setBusyId(null);
    }
  };

  const handleReprocess = (receipt: EmailReceiptListItem) =>
    runCommand(
      receipt,
      async () => {
        await emailReceiptsApi.receipts.reprocess(receipt.id);
        toast.success(t('toasts.reprocessed'));
        return null;
      },
      t('toasts.reprocessFailed'),
    );

  /**
   * Queue a parser-draft request for these emails and open the chat or leave it in
   * the inbox (`useParserDraftWithAi`). The chat opening is the page changing, so
   * only the other two outcomes leave a notice behind.
   */
  const handleDraftParser = async (receipts: readonly EmailReceiptListItem[]) => {
    if (receipts.length === 0) return;
    setDrafting(true);
    setNotice(null);
    try {
      const outcome = await startParserDraft(receipts);
      if (outcome.kind === 'failed') {
        setNotice({ tone: 'error', text: outcome.message });
      } else {
        if (outcome.kind === 'queued') {
          setNotice({
            tone: 'success',
            text: outcome.handoffFailed ? t('draft.handoffFailed') : t('draft.queued'),
            link: { href: '/ai-reviews', label: t('draft.inboxLink') },
          });
        }
        clearSelection();
      }
    } finally {
      setDrafting(false);
    }
  };

  // Several sender domains are for one transaction's linked emails: confirm that before any request is made.
  const askDraft = () => {
    if (distinctSenderDomains(selected).length > 1) setLinkedDraftFor(selected);
    else void handleDraftParser(selected);
  };

  const handleApprove = (receipt: EmailReceiptListItem) => {
    // A trade creates an investment transaction: it is approved on its card in
    // the review inbox, where the account, the ticker and the total are shown,
    // never blind from this list.
    if (receipt.isTrade) {
      router.push('/ai-reviews?kind=email_receipt');
      return;
    }
    return runCommand(
      receipt,
      async () => {
        if (!receipt.aiReviewRequestId) throw new Error('no proposal');
        await emailReceiptsApi.receipts.approveProposal(receipt.aiReviewRequestId);
        toast.success(t('toasts.approved'));
        return null;
      },
      t('toasts.approveFailed'),
    );
  };

  // Ticking or unticking a row leaves "every email matching the filter": what is selected is then the rows.
  const toggleSelected = (receipt: EmailReceiptListItem) => {
    const next = new Map(allMatching !== null ? pageItems.map((row) => [row.id, row] as const) : selectedRows);
    if (next.has(receipt.id)) next.delete(receipt.id);
    else next.set(receipt.id, receipt);
    leaveAllMatching();
    setSelectedRows(next);
  };

  const handleConfirm = async () => {
    const target = confirmation;
    setConfirmation(null);
    if (!target) return;
    if (target.kind === 'ignore') {
      await runCommand(
        target.receipt,
        async () => {
          await emailReceiptsApi.receipts.ignore(target.receipt.id);
          toast.success(t('toasts.ignored'));
          return null;
        },
        t('toasts.ignoreFailed'),
      );
    } else {
      await runCommand(
        target.receipt,
        async () => {
          await emailReceiptsApi.receipts.remove(target.receipt.id);
          toast.success(t('toasts.deleted'));
          return null;
        },
        t('toasts.deleteFailed'),
      );
    }
  };

  const actionsFor = (receipt: EmailReceiptListItem): RowAction[] => {
    const actionable = isReceiptActionable(receipt);
    const disabled = busyId === receipt.id;
    // Each action is built by its key, in the order its card sets, so no handler is handed to another
    // function while the row renders.
    const build: Record<ReceiptActionKey, () => RowAction> = {
      view: () => ({
        key: 'view',
        label: t('actions.view'),
        icon: 'view',
        tone: 'view',
        onClick: () => setDetailId(receipt.id),
        disabled,
      }),
      approve: () => ({
        // The proposal this email made, applied as the review inbox's Confirm does.
        key: 'approve',
        label: receipt.isTrade ? t('actions.reviewTrade') : t('actions.approve'),
        icon: 'post',
        tone: 'success',
        onClick: () => void handleApprove(receipt),
        hidden: receipt.status !== 'review' || receipt.displayState !== 'proposed',
        disabled,
      }),
      draftParser: () => ({
        // The inline action of an email no parser read: the person's own request
        // to the assistant, offered whatever the mailbox's AI mode.
        key: 'draftParser',
        label: t('actions.draftParser'),
        icon: 'duplicate',
        tone: 'accent',
        onClick: () => void handleDraftParser([receipt]),
        hidden: !canDraftParser(receipt),
        disabled: disabled || drafting,
      }),
      createParser: () => ({
        key: 'createParser',
        label: t('actions.createParser'),
        icon: 'edit',
        tone: 'primary',
        onClick: () => setParserFor(receipt),
        hidden: receipt.status !== 'no_parser',
        disabled,
      }),
      link: () => ({
        key: 'link',
        label: t('actions.link'),
        icon: 'transactions',
        tone: 'primary',
        onClick: () => setDetailId(receipt.id),
        // The candidates of an ambiguous email, or the picker of one the matcher
        // could not tie to a transaction.
        hidden: receipt.isTrade ? !canLinkTradeEmail(receipt) : !LINKABLE_STATUSES.includes(receipt.status),
        disabled,
      }),
      recognizeAi: () => ({
        // Offered whatever the mailbox's AI mode: the mode governs only what
        // happens by itself, and pressing this is the person's own consent.
        key: 'recognizeAi',
        label: t('actions.recognizeAi'),
        icon: 'reconcile',
        tone: 'accent',
        onClick: () => setRecognizeFor({ receipt, asTrade: false }),
        // A trade email creates a transaction: there is no bank transaction to split.
        hidden: receipt.isTrade || !canRecognizeWithAi(receipt),
        disabled,
      }),
      recognizeTradeAi: () => ({
        // The email is a brokerage trade confirmation: the AI proposes the
        // investment transaction it reports. Offered where "Recognize with AI" is.
        key: 'recognizeTradeAi',
        label: t('actions.recognizeTradeAi'),
        icon: 'reconcile',
        tone: 'accent',
        onClick: () => setRecognizeFor({ receipt, asTrade: true }),
        hidden: !canRecognizeWithAi(receipt),
        disabled,
      }),
      reprocess: () => ({
        key: 'reprocess',
        label: t('actions.reprocess'),
        icon: 'reopen',
        tone: 'primary',
        onClick: () => void handleReprocess(receipt),
        // A trade the ledger already held is read again too: it may have been entered by mistake.
        hidden: !canReprocessReceipt(receipt),
        disabled,
      }),
      ignore: () => ({
        key: 'ignore',
        label: t('actions.ignore'),
        icon: 'skip',
        tone: 'warning',
        onClick: () => setConfirmation({ kind: 'ignore', receipt }),
        hidden: !actionable,
        disabled,
      }),
      delete: () => ({
        key: 'delete',
        label: tc('delete'),
        icon: 'delete',
        tone: 'delete',
        destructive: true,
        onClick: () => setConfirmation({ kind: 'delete', receipt }),
        disabled,
      }),
    };
    // The card being looked at decides which action leads (and so shows inline first).
    return orderActionsForCard(ROW_ACTION_KEYS, leadActionKey(filter, receipt)).map(({ key }) => build[key]());
  };

  const current =
    loaded !== null &&
    loaded.filter === filter &&
    loaded.domain === domain &&
    loaded.searchKey === searchKey &&
    loaded.page === page
      ? loaded
      : null;
  // Counts and domain lists of another search are not these emails' numbers: unknown until theirs arrive.
  const countsNow = counts !== null && counts.searchKey === searchKey ? counts.items : null;
  const domainsNow = domains !== null && domains.searchKey === searchKey ? domains.items : null;
  const pageItems = current?.items ?? [];
  // Every ticked email: the rows on screen in list order, as loaded now, then the ones on other pages or lists as last seen.
  const pageIds = new Set(pageItems.map((receipt) => receipt.id));
  const shownSelected = pageItems.filter((receipt) => selectedRows.has(receipt.id));
  const selected = [...shownSelected, ...[...selectedRows.values()].filter((receipt) => !pageIds.has(receipt.id))];
  const hiddenSelectedCount = selected.length - shownSelected.length;
  const selectedDomains = distinctSenderDomains(selected);
  const matchingTotal =
    matching !== null && matching.filter === filter && matching.domain === domain && matching.searchKey === searchKey
      ? matching.total
      : null;
  // The narrowed number once exclusions are on; until its count arrives the unnarrowed one stands in and the commands wait (`narrowing.pending`).
  const allMatchingCount =
    allMatching !== null ? ((narrowing.active ? narrowing.count : null) ?? matchingTotal ?? allMatching) : null;

  // Pages come from the total the server counted for this filter. Unknown (the count failed) is not zero: Next stays open while the page came back full.
  const totalPages = matchingTotal !== null ? Math.max(1, Math.ceil(matchingTotal / PAGE_SIZE)) : null;
  const unknownTotalPager =
    matchingTotal === null && current !== null && current.items !== null && (page > 1 || current.items.length >= PAGE_SIZE)
      ? current.items
      : null;

  // The tag cloud counts within the state on screen; "All" reads the unfiltered list.
  const cloudDomains =
    filter === 'all'
      ? domainsNow
      : cloud !== null && cloud.filter === filter && cloud.searchKey === searchKey
        ? cloud.items
        : null;

  // The header checkbox covers every row of the page.
  const isChecked = (receipt: EmailReceiptListItem) => allMatching !== null || selectedRows.has(receipt.id);
  const allSelected = pageItems.length > 0 && pageItems.every(isChecked);
  const someSelected = pageItems.some(isChecked) && !allSelected;
  // Gmail style: a full page, and more emails matching the filter than the page holds.
  const canSelectAllMatching = allMatching === null && allSelected && matchingTotal !== null && matchingTotal > pageItems.length;

  // The header box acts on this page's rows only: ticks of other pages and senders stay. Over "every email matching" it clears all.
  const toggleAll = () => {
    if (allMatching !== null) {
      clearSelection();
      return;
    }
    const next = new Map(selectedRows);
    for (const receipt of pageItems) {
      if (allSelected) next.delete(receipt.id);
      else next.set(receipt.id, receipt);
    }
    setSelectedRows(next);
  };

  const askBulk = (action: 'delete' | 'ignore') =>
    allMatchingCount !== null
      ? bulk.ask(action, { filter: narrowing.filter }, allMatchingCount)
      : bulk.ask(action, { ids: selected.map((receipt) => receipt.id) }, selected.length);

  // Every command names the same emails: the ticked ids, or the filter with what was taken out of it.
  const bulkScope = (): EmailReceiptBulkScope =>
    allMatching !== null ? { filter: narrowing.filter } : { ids: selected.map((receipt) => receipt.id) };

  const approvableSelected = selected.filter(isBulkApprovable);
  const ignoredSelected = selected.filter((receipt) => receipt.status === 'ignored').length;
  const excludedStatuses = narrowing.exclusions.statuses;
  // An "every email matching" selection can hold what its state filter and exclusions leave in.
  const canHoldState = (status: EmailReceiptStatus) =>
    (filter === 'all' || filter === status) && !excludedStatuses.includes(status);

  const handleBulkApprove = () =>
    allMatching !== null
      ? void processing.askApprovalFor({ filter: narrowing.filter })
      : processing.offerApproval({
          requestIds: approvableSelected.flatMap((receipt) => (receipt.aiReviewRequestId ? [receipt.aiReviewRequestId] : [])),
          trades: selected.filter(isTradeProposal).length,
        });

  // Ticked rows are judged by their own state, sender and day; "every email matching" is narrowed on the server.
  const handleDeselect = (deselection: Deselection) => {
    if (allMatching !== null) {
      narrowing.narrow(deselection);
      return;
    }
    setSelectedRows(
      new Map(selected.filter((receipt) => !deselects(receipt, deselection)).map((receipt) => [receipt.id, receipt] as const)),
    );
  };

  const statusOptions: EmailReceiptStatus[] =
    allMatching === null
      ? EMAIL_RECEIPT_STATUSES.filter((status) => selected.some((receipt) => receipt.status === status))
      : filter !== 'all' || countsNow === null
        ? []
        : EMAIL_RECEIPT_STATUSES.filter((status) => (countsNow[status] ?? 0) > 0 && !excludedStatuses.includes(status));
  const excludedDomains = narrowing.exclusions.domains;
  const domainOptions: string[] =
    allMatching === null
      ? selectedDomains
      : domain !== ''
        ? []
        : (cloudDomains ?? [])
            .map((item) => item.domain)
            .filter((name) => !excludedDomains.includes(name))
            .slice(0, MAX_DOMAIN_OPTIONS);

  /** The label of a state's button: its name with how many emails are in it, when that is known. */
  const filterLabel = (option: ReceiptFilter) => {
    const label = t(`filter.${option}`);
    if (countsNow === null) return label;
    const count =
      option === 'all'
        ? EMAIL_RECEIPT_STATUSES.reduce((sum, status) => sum + (countsNow[status] ?? 0), 0)
        : (countsNow[option] ?? 0);
    return t('filter.option', { label, count: formatNumber(count, 0) });
  };

  // "Retry failed emails" is offered only while the counts say some email could not be read. It retries
  // every such email, so under a search (whose counts are narrowed) it is withheld rather than show a number it does not act on.
  const failedCount = receiptSearch.active ? 0 : (countsNow?.parse_failed ?? 0);

  let body;
  if (current !== null && current.items === null) {
    body = (
      <div role="alert">
        <EmptyState
          icon={<ExclamationTriangleIcon />}
          title={t('error.title')}
          description={t('error.body')}
          action={<Button onClick={() => void reload()}>{t('error.retry')}</Button>}
        />
      </div>
    );
  } else if (current === null) {
    body = <LoadingSpinner text={t('loading')} />;
  } else if (current.items === null || current.items.length === 0) {
    const searching = receiptSearch.active;
    const unfiltered = filter === 'all' && domain === '' && !searching;
    const noMailbox = mailbox.status === 'none' && unfiltered;
    body = (
      <EmptyState
        icon={<EnvelopeIcon />}
        title={searching ? t('empty.searchTitle') : unfiltered ? t('empty.title') : t('empty.filteredTitle')}
        description={
          searching
            ? t('empty.searchBody')
            : noMailbox
              ? t('empty.noMailboxBody')
              : unfiltered
                ? t('empty.body')
                : t('empty.filteredBody')
        }
        action={
          searching ? (
            <Button variant="outline" onClick={receiptSearch.clear}>
              {t('search.clear')}
            </Button>
          ) : noMailbox ? (
            <Link href="/email-receipts?tab=mailbox" className={buttonClassName('primary', 'md')}>
              {t('empty.connectButton')}
            </Link>
          ) : undefined
        }
        help={unfiltered ? 'emailReceipts' : undefined}
      />
    );
  } else {
    body = (
      <ReceiptListTable
        items={current.items}
        isChecked={isChecked}
        allSelected={allSelected}
        someSelected={someSelected}
        selectionDisabled={drafting || locked}
        onToggle={toggleSelected}
        onToggleAll={toggleAll}
        actionsFor={actionsFor}
      />
    );
  }

  const confirmCopy = confirmation?.kind === 'delete' ? 'deleteDialog' : 'ignoreDialog';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <Link href="/ai-reviews" className="text-blue-600 hover:underline dark:text-blue-400">
          {t('links.reviewInbox')}
        </Link>
        <Link href="/email-receipts?tab=mailbox" className="text-blue-600 hover:underline dark:text-blue-400">
          {t('links.settings')}
        </Link>
      </div>

      <LinkedProfilesHint variant="emails" />

      {/* The search leads the toolbar; the state and sender filters follow it. */}
      <ReceiptSearchBar
        input={receiptSearch.input}
        onChange={receiptSearch.change}
        onClear={receiptSearch.clear}
        canClear={receiptSearch.hasInput}
        rangeBackwards={receiptSearch.rangeBackwards}
      />
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div role="group" aria-label={t('filter.label')} className={`${SEGMENTED_GROUP_CLASS} max-w-full flex-wrap`}>
          {FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={filter === option}
              onClick={() => {
                setFilter(option);
                setPage(1);
                leaveAllMatching();
              }}
              className={segmentClass(filter === option)}
            >
              {filterLabel(option)}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('domainFilter.label')}</span>
        <SenderDomainCloud domains={cloudDomains} selected={domain} onSelect={changeDomain} />
      </div>
      {domain !== '' && <p className="text-xs text-gray-500 dark:text-gray-400">{t('domainFilter.help', { domain })}</p>}

      {failedCount > 0 && (
        <RetryFailedEmailsButton
          count={failedCount}
          domain={domain === '' ? undefined : domain}
          onFinished={() => void reload()}
        />
      )}

      {notice && (
        <div
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={
            notice.tone === 'error'
              ? 'rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-200'
              : 'rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900/60 dark:bg-green-900/20 dark:text-green-200'
          }
        >
          {notice.text}
          {notice.link && (
            <>
              {' '}
              <Link href={notice.link.href} className="font-medium underline">
                {notice.link.label}
              </Link>
            </>
          )}
        </div>
      )}

      {(allMatching !== null || selected.length > 0) && (
        <ReceiptBulkBar
          count={allMatchingCount ?? selected.length}
          allMatching={allMatching !== null}
          pageCount={pageItems.length}
          hiddenCount={allMatching !== null ? 0 : hiddenSelectedCount}
          matchingTotal={matchingTotal}
          canSelectAllMatching={canSelectAllMatching}
          draftBlock={draftBlock(selected, allMatching !== null)}
          senderDomains={selectedDomains}
          busy={locked}
          drafting={drafting}
          countPending={narrowing.pending}
          progress={processing.progress}
          restore={
            allMatching !== null
              ? { visible: canHoldState('ignored'), count: null }
              : { visible: ignoredSelected > 0, count: ignoredSelected }
          }
          approve={
            allMatching !== null
              ? { visible: canHoldState('review'), count: null }
              : { visible: approvableSelected.length > 0, count: approvableSelected.length }
          }
          statusOptions={statusOptions}
          domainOptions={domainOptions}
          exclusions={narrowing.exclusions}
          onSelectAllMatching={() => {
            // The selection is the filter from here on, not the rows that were ticked.
            setSelectedRows(new Map());
            setAllMatching(matchingTotal);
          }}
          onReprocess={() => void processing.reprocess(bulkScope(), 'reprocess')}
          onRestore={() => void processing.reprocess(bulkScope(), 'restore')}
          onApprove={handleBulkApprove}
          onStop={processing.stop}
          onDeselect={handleDeselect}
          onChangeExclusions={narrowing.restore}
          onDelete={() => askBulk('delete')}
          onIgnore={() => askBulk('ignore')}
          onDraft={askDraft}
          onClear={clearSelection}
        />
      )}

      <Card className="overflow-hidden">{body}</Card>

      {totalPages !== null && matchingTotal !== null && (
        <ListBottomPager
          currentPage={Math.min(page, totalPages)}
          totalPages={totalPages}
          totalItems={matchingTotal}
          pageSize={PAGE_SIZE}
          onPageChange={changePage}
          itemName={t('pager.itemName')}
          totalLabel={t('pager.total', { count: matchingTotal })}
        />
      )}
      {unknownTotalPager !== null && (
        <div className="flex items-center justify-center gap-3 text-sm text-gray-700 dark:text-gray-300">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => changePage(page - 1)}>
            {tc('pagination.previousPage')}
          </Button>
          <span>{t('pager.page', { page })}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={unknownTotalPager.length < PAGE_SIZE}
            onClick={() => changePage(page + 1)}
          >
            {tc('pagination.nextPage')}
          </Button>
        </div>
      )}

      {detailId !== null && (
        <EmailReceiptDetailDialog
          key={detailId}
          receiptId={detailId}
          categoryLabels={categoryLabels}
          onClose={closeDetail}
          onOpenReceipt={setDetailId}
          onChanged={() => void reload()}
        />
      )}

      {parserFor !== null && (
        <ParserEditorDialog
          parser={null}
          prefill={{
            name: parserFor.fromDomain || senderDomain(parserFor.fromAddress),
            fromDomains: parserFor.fromDomain || senderDomain(parserFor.fromAddress),
            // A profile made from a trade confirmation starts as a trade profile.
            kind: parserFor.isTrade ? 'trade' : 'receipt',
          }}
          initialReceiptId={parserFor.id}
          lookups={lookups}
          onReloadLookups={reloadLookups}
          onClose={() => setParserFor(null)}
          onSaved={(saved) => {
            setParserFor(null);
            void reload();
            void discardOffer.offer(saved);
          }}
          onConflict={() => setParserFor(null)}
        />
      )}

      {discardOffer.dialog}

      {recognizeFor !== null && (
        <RecognizeWithAiDialog
          key={`${recognizeFor.receipt.id}:${recognizeFor.asTrade}`}
          receipt={recognizeFor.receipt}
          asTrade={recognizeFor.asTrade}
          onClose={() => setRecognizeFor(null)}
          onChanged={() => void reload()}
        />
      )}

      <LinkedDraftDialog
        domains={linkedDraftFor === null ? [] : senderDomainCounts(linkedDraftFor)}
        isOpen={linkedDraftFor !== null}
        onConfirm={() => {
          const receipts = linkedDraftFor;
          setLinkedDraftFor(null);
          if (receipts !== null) void handleDraftParser(receipts);
        }}
        onCancel={() => setLinkedDraftFor(null)}
      />

      <BulkConfirmDialog
        request={bulk.request}
        running={bulk.running}
        onConfirm={() => void bulk.confirm()}
        onCancel={bulk.cancel}
      />

      <ConfirmDialog
        isOpen={processing.approval !== null}
        title={t('bulkDialog.approve.title')}
        message={
          processing.approval === null
            ? ''
            : [
                t('bulkDialog.approve.message', { count: processing.approval.requestIds.length }),
                ...(processing.approval.trades > 0
                  ? [t('bulkDialog.approve.trades', { count: processing.approval.trades })]
                  : []),
              ].join(' ')
        }
        confirmLabel={t('bulkDialog.approve.confirm')}
        variant="info"
        onConfirm={() => void processing.confirmApproval()}
        onCancel={processing.cancelApproval}
      />

      <ConfirmDialog
        isOpen={confirmation !== null}
        title={t(`${confirmCopy}.title`)}
        message={t(`${confirmCopy}.message`, { subject: confirmation?.receipt.subject ?? '' })}
        confirmLabel={confirmation?.kind === 'delete' ? tc('delete') : t('ignoreDialog.confirm')}
        variant={confirmation?.kind === 'delete' ? 'danger' : 'warning'}
        onConfirm={() => void handleConfirm()}
        onCancel={() => setConfirmation(null)}
      />
    </div>
  );
}
