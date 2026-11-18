import { randomBytes } from "node:crypto";

/**
 * Row ids that sort in the order they are handed out (S1).
 *
 * Every row an import writes shares `created_at` (one transaction), so the
 * canonical replay order, `INVESTMENT_REPLAY_ORDER` (date, created_at, id),
 * breaks a same-day tie on the id. A random UUID makes that tie-break random:
 * a same-day stock split and buy fold to 210 shares on one run and 220 on the
 * next, a same-day sell and buy to two different average costs. Handed out in
 * the source's journal order -- KMyMoney's post date then transaction id
 * (`kmy-map-investments.ts`), Money's date then `htrn` (`map-investments.ts`)
 * -- these ids make the canonical order the source's own, with no second
 * ordering scheme beside it; `orderForReplay` sorts the mapped rows by the same
 * (date, id) pair before the import checks its own replay.
 *
 * Each id is a UUIDv7 (RFC 9562): the 48-bit Unix time in milliseconds of the
 * generator's creation, the version, a 42-bit counter in `rand_a` and the top
 * of `rand_b` (the RFC's "fixed bit-length dedicated counter"), the variant,
 * and 32 random bits. PostgreSQL compares `uuid` bytewise, as the hex text
 * compares, so a later id sorts after an earlier one.
 */
export function sortableRowIds(now: number = Date.now()): () => string {
  const time = BigInt(now) & 0xffff_ffff_ffffn;
  let counter = 0n;
  return () => {
    const c = counter;
    counter += 1n;
    const bytes = Buffer.alloc(16);
    bytes.writeUIntBE(Number(time), 0, 6);
    bytes[6] = 0x70 | Number((c >> 38n) & 0x0fn);
    bytes[7] = Number((c >> 30n) & 0xffn);
    bytes[8] = 0x80 | Number((c >> 24n) & 0x3fn);
    bytes[9] = Number((c >> 16n) & 0xffn);
    bytes[10] = Number((c >> 8n) & 0xffn);
    bytes[11] = Number(c & 0xffn);
    randomBytes(4).copy(bytes, 12);
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}
