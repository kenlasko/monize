import { POLISH_BOND_ADAPTER } from "./adapters/pl";
import { UNITED_STATES_BOND_ADAPTER } from "./adapters/us";
import { BondAdapter, BondProgramDefinition } from "./bond-adapter";
import {
  CalendarRegistry,
  EMPTY_CALENDAR_REGISTRY,
} from "./domain/calendar-registry";

/**
 * Every installed country adapter, the one place adapters are wired. Adding a
 * country is one more entry here; the domain and the engine never learn of it.
 */
export const INSTALLED_BOND_ADAPTERS: readonly BondAdapter[] = [
  POLISH_BOND_ADAPTER,
  UNITED_STATES_BOND_ADAPTER,
];

export const BOND_CALENDARS: CalendarRegistry = INSTALLED_BOND_ADAPTERS.reduce(
  (registry, adapter) => adapter.registerCalendars(registry),
  EMPTY_CALENDAR_REGISTRY,
);

/** The installed adapter's declaration of a stored program, or undefined when none declares it. */
function templateProgramOf(program: {
  readonly issuerCountryCode: string;
  readonly issuerCode: string;
  readonly programCode: string;
}): BondProgramDefinition | undefined {
  for (const adapter of INSTALLED_BOND_ADAPTERS) {
    const found = adapter.programs.find(
      (p) =>
        p.issuerCountryCode === program.issuerCountryCode &&
        p.issuerCode === program.issuerCode &&
        p.programCode === program.programCode,
    );
    if (found) return found;
  }
  return undefined;
}

/**
 * The nominal of one bond of a program, from the installed adapter's product
 * template (`BondProgramDefinition.faceValue`), or null when no installed
 * adapter declares the program. The program is named by the stored row's own
 * key, so no country's code or product is known here.
 */
export function templateFaceValueOf(program: {
  readonly issuerCountryCode: string;
  readonly issuerCode: string;
  readonly programCode: string;
}): string | null {
  return templateProgramOf(program)?.faceValue ?? null;
}

/**
 * Whether the program's template says its principal is indexed
 * (`BondProgramDefinition.indexedPrincipal`); false when no installed adapter
 * declares the program.
 */
export function templateIndexedPrincipalOf(program: {
  readonly issuerCountryCode: string;
  readonly issuerCode: string;
  readonly programCode: string;
}): boolean {
  return templateProgramOf(program)?.indexedPrincipal === true;
}

/**
 * Whether the program's template says its unit price is a cash price that may
 * sit far from the face value (`BondProgramDefinition.cashPriced`); false when
 * no installed adapter declares the program.
 */
export function templateCashPricedOf(program: {
  readonly issuerCountryCode: string;
  readonly issuerCode: string;
  readonly programCode: string;
}): boolean {
  return templateProgramOf(program)?.cashPriced === true;
}
