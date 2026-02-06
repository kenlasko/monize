/**
 * Lightweight frontend logger utility.
 *
 * Log level is controlled by NEXT_PUBLIC_LOG_LEVEL (default: 'info').
 * Levels: error > warn > info > debug
 *
 * Usage:
 *   const logger = createLogger('Investments');
 *   logger.error('Failed to load data:', error);  // level >= error
 *   logger.warn('Unexpected state');               // level >= warn
 *   logger.info('Component mounted');              // level >= info (default)
 *   logger.debug('Payload received', data);        // level >= debug
 */

export interface Logger {
  readonly error: (...args: unknown[]) => void;
  readonly warn: (...args: unknown[]) => void;
  readonly info: (...args: unknown[]) => void;
  readonly debug: (...args: unknown[]) => void;
}

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

function getConfiguredLevel(): number {
  const raw = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_LOG_LEVEL) || 'info';
  return LOG_LEVELS[raw as LogLevel] ?? LOG_LEVELS.info;
}

const configuredLevel = getConfiguredLevel();

const noop = () => {};

export function createLogger(context: string): Logger {
  const tag = `[${context}]`;

  return {
    error: configuredLevel >= LOG_LEVELS.error
      ? (...args: unknown[]) => { console.error(tag, ...args); }
      : noop,
    warn: configuredLevel >= LOG_LEVELS.warn
      ? (...args: unknown[]) => { console.warn(tag, ...args); }
      : noop,
    info: configuredLevel >= LOG_LEVELS.info
      ? (...args: unknown[]) => { console.info(tag, ...args); }
      : noop,
    debug: configuredLevel >= LOG_LEVELS.debug
      ? (...args: unknown[]) => { console.debug(tag, ...args); }
      : noop,
  };
}
