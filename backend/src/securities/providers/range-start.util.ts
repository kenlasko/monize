/**
 * The first day a named history range ("5d", "6mo", "1y", "max") reaches back
 * to from `to`. One definition for every provider that turns a range into a
 * date window, so a new range string is handled in one place: `max` is thirty
 * years, and a string this does not read is one year.
 */
export function rangeToStartDate(range: string, to: Date): Date {
  const start = new Date(to);
  const normalized = range.trim().toLowerCase();
  if (normalized === "max") {
    start.setUTCFullYear(start.getUTCFullYear() - 30);
    return start;
  }
  const m = /^(\d+)(d|mo|y)$/.exec(normalized);
  if (!m) {
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    return start;
  }
  const n = Number(m[1]);
  if (m[2] === "d") start.setUTCDate(start.getUTCDate() - n);
  else if (m[2] === "mo") start.setUTCMonth(start.getUTCMonth() - n);
  else start.setUTCFullYear(start.getUTCFullYear() - n);
  return start;
}
