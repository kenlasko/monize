import { resolveTimezone } from './utils';

export type GreetingPeriod = 'morning' | 'afternoon' | 'evening';

/**
 * Which part of the day `now` falls in for the reader, in their timezone
 * preference (`'browser'` or unset follows the device): before noon is the
 * morning, noon to 18:00 the afternoon, the rest the evening. The dashboard
 * greeting reads it.
 */
export function greetingPeriod(now: Date, timezonePref: string | undefined): GreetingPeriod {
  const hourPart = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hourCycle: 'h23',
    timeZone: resolveTimezone(timezonePref),
  })
    .formatToParts(now)
    .find((part) => part.type === 'hour');
  const hour = Number(hourPart?.value ?? '0') % 24;
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}
