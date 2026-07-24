import type { TourDefinition } from './types';
import { INTRO_TOUR } from './definitions/intro';
import { RELEASE_1_13_TOURS } from './definitions/release-1.13.0';

export { INTRO_TOUR } from './definitions/intro';

/** Every tour known to the app: the evergreen intro plus all release tours. */
export const ALL_TOURS: readonly TourDefinition[] = [
  INTRO_TOUR,
  ...RELEASE_1_13_TOURS,
];

/** Look up a tour by its persistence id. */
export function getTourById(id: string): TourDefinition | undefined {
  return ALL_TOURS.find((tour) => tour.id === id);
}

/** Truncate a version to its major.minor line ('1.13.2' -> '1.13'). */
export function toMinorLine(version: string): string {
  const parts = version.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : version;
}

/**
 * Release tours matching the running version's **minor line**. Matching on
 * major.minor (not the exact patch) keeps the tours offered for the whole
 * 1.13.x line and reaches users who upgrade straight across the minor; a new
 * minor supersedes them (its tours match instead, the old ones stop matching).
 */
export function getReleaseTours(version: string): readonly TourDefinition[] {
  const minor = toMinorLine(version);
  return ALL_TOURS.filter((tour) => tour.version === minor);
}
