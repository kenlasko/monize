import { SimulationResult } from './monte-carlo';

const STORAGE_KEY = 'monize:monte-carlo-results';

type CacheMap = Record<string, SimulationResult>;

function read(): CacheMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as CacheMap) : {};
  } catch {
    return {};
  }
}

function write(map: CacheMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / privacy errors */
  }
}

export function getCachedResult(scenarioId: string): SimulationResult | null {
  return read()[scenarioId] ?? null;
}

export function setCachedResult(
  scenarioId: string,
  result: SimulationResult,
): void {
  const all = read();
  all[scenarioId] = result;
  write(all);
}

export function clearCachedResult(scenarioId: string): void {
  const all = read();
  if (scenarioId in all) {
    delete all[scenarioId];
    write(all);
  }
}

export const MONTE_CARLO_RESULTS_STORAGE_KEY = STORAGE_KEY;
