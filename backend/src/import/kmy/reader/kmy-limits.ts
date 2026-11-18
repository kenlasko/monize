/**
 * What one KMyMoney file may cost the server (spec 4.2, B2). Every bound is
 * enforced while the document is read, so a hostile file is refused as soon
 * as it crosses one, never after it has been inflated, held and modelled.
 *
 * The numbers come from measured files (backend/src/import/kmy/README.md,
 * "Memory and time"): a 50,000-transaction file is 22.8 MB of XML and a
 * 120,000-transaction one 59 MB, with three to four retained records (the
 * transaction and its splits, plus prices and payees) per transaction. A
 * repetitive document compresses about 300 to 1 (2.45 million transactions,
 * 278 MiB of XML, gzip to 967 KiB), so the upload limit says nothing about
 * what the inflated document costs, and these bounds are separate from it.
 */

/**
 * Inflated (or uploaded, for plain XML) document bytes. 1.7 times the largest
 * real file measured (59 MB for 120,000 transactions): about 200,000
 * transactions of ordinary density. Deliberately far below the 300 MB upload
 * limit Money shares: the record bound below is what holds memory, and a
 * document at both bounds costs about 470 MB to read and map (README).
 */
export const KMY_MAX_XML_BYTES = 100 * 1024 * 1024;

/**
 * Records the reader keeps (accounts, payees, transactions, splits, prices,
 * schedules, key/value pairs and the rest). A real file keeps about three per
 * transaction (the transaction and its splits) plus its prices and payees, so
 * the 120,000-transaction file is about 400,000; this is 1.5 times that, and
 * the same 200,000 transactions as the byte bound. It is the bound on the raw
 * model's and the mapped model's memory and on the mapper's run, which a
 * dense document could otherwise multiply within the byte bound (a 20-byte
 * split is a record). README, "Memory and time", has the cost at the bound.
 */
export const KMY_MAX_RECORDS = 600_000;

/**
 * Elements of any kind, kept or skipped (REPORT and BUDGET bodies are read and
 * dropped). Over three times the record bound, so ordinary report and budget
 * definitions never reach it, while a document of millions of empty elements
 * is refused before it costs the tokenizer seconds.
 */
export const KMY_MAX_ELEMENTS = 2_000_000;

/** Splits in one transaction or schedule template; KMyMoney's own UI shows a handful. */
export const KMY_MAX_SPLITS_PER_TRANSACTION = 10_000;

/**
 * Characters in one attribute value. The longest real values are memos, payee
 * notes and the escaped matched-transaction document KMyMoney keeps in a
 * split's `kmm-matched-tx` pair, a few kilobytes each.
 */
export const KMY_MAX_ATTRIBUTE_CHARS = 1024 * 1024;

/** Document bytes handed to the tokenizer before the reader yields to the event loop. */
export const KMY_YIELD_EVERY_BYTES = 256 * 1024;
