import { execSync } from 'child_process'
import { parse } from 'csv-parse/sync'

const MAX_BUFFER = 256 * 1024 * 1024 // 256 MB — large tables (TRN, SP) need room

/**
 * Shells out to mdb-export and parses the resulting CSV into row objects.
 */
export function readTable(
  mdbFile: string,
  table: string,
): Record<string, string>[] {
  const csv = execSync(`mdb-export "${mdbFile}" "${table}"`, {
    maxBuffer: MAX_BUFFER,
  }).toString('utf-8')
  return parse(csv, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    trim: true,
  }) as Record<string, string>[]
}

/**
 * Parses a Microsoft Money date string (MM/DD/YY HH:MM:SS) into a YYYY-MM-DD string.
 * Returns null for the Money null-date sentinel (day component '00') and unparseable values.
 * Uses a 70-year pivot: YY >= 70 maps to 1900s, < 70 maps to 2000s.
 */
export function parseMnyDate(raw: string): string | null {
  if (!raw) return null
  const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{2})/)
  if (!match) return null
  const [, mm, dd, yy] = match
  if (dd === '00') return null
  const y = parseInt(yy, 10)
  const year = y >= 70 ? 1900 + y : 2000 + y
  return `${year}-${mm}-${dd}`
}

/**
 * Maps a Microsoft Money account type integer to the monize account_type enum value.
 */
export function parseAccountType(at: number): string {
  const map: Record<number, string> = {
    0: 'CHEQUING',
    1: 'CREDIT_CARD',
    2: 'CASH',
    3: 'ASSET',
    4: 'LOAN',
    5: 'INVESTMENT',
    6: 'MORTGAGE',
  }
  const result = map[at]
  if (result === undefined) throw new Error(`Unknown account type: ${at}`)
  return result
}

/**
 * Maps a Microsoft Money frequency integer to the monize scheduled transaction frequency.
 */
export function parseFrequency(frq: number): string {
  const map: Record<number, string> = {
    0: 'ONCE',
    1: 'DAILY',
    2: 'WEEKLY',
    3: 'MONTHLY',
    4: 'YEARLY',
    5: 'BIWEEKLY',
    6: 'QUARTERLY',
    7: 'YEARLY',
  }
  const result = map[frq]
  if (result === undefined) throw new Error(`Unknown frequency: ${frq}`)
  return result
}

/**
 * Builds a map from Money currency handle (hcrnc) to ISO currency code.
 */
export function buildCurrencyMap(
  crncRows: Record<string, string>[],
): Map<string, string> {
  const map = new Map<string, string>()
  for (const row of crncRows) {
    const hcrnc = row['hcrnc']
    const isoCode = row['szIsoCode']?.trim()
    if (hcrnc && isoCode) {
      map.set(hcrnc, isoCode)
    }
  }
  return map
}
