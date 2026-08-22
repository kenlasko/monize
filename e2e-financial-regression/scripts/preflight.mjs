import { execFileSync } from 'node:child_process';
import { loadConfig, fail, warn, info } from './lib/env.mjs';

// Environment safety gate. Every check here refuses rather than guesses: the
// harness reads a real database through the browser, so an unconfigured or
// unsafe-looking environment must stop the run cold, not proceed hopefully.

const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'host.docker.internal',
  'postgres',
]);

function isProdLike(value) {
  return /\b(prod|production|live)\b/i.test(value || '');
}

/** Validate config, classify the run mode, and return normalized settings. */
export function runPreflight(config = loadConfig()) {
  const problems = [];
  const req = (key) => {
    if (!config[key] || config[key].trim() === '') problems.push(`${key} is required but empty.`);
  };

  // 1. Explicit safety acknowledgement.
  if (config.I_UNDERSTAND_THIS_IS_READ_ONLY_ON_A_DISPOSABLE_DB !== 'yes') {
    problems.push(
      'I_UNDERSTAND_THIS_IS_READ_ONLY_ON_A_DISPOSABLE_DB must be exactly "yes". ' +
        'Point this harness at a DISPOSABLE COPY of your data and confirm you understand it is read-only.',
    );
  }

  // 2. Existing-user credentials.
  req('MONIZE_USER_EMAIL');
  req('MONIZE_USER_PASSWORD');

  // 3. Run mode: URL mode (you run the apps) vs Docker mode (harness runs them).
  const urlMode = Boolean(config.MONIZE_BEFORE_URL && config.MONIZE_AFTER_URL);
  const mode = urlMode ? 'url' : 'docker';

  if (mode === 'docker') {
    req('MONIZE_BEFORE_REF');
    req('MONIZE_AFTER_REF');
    req('MONIZE_DB_HOST');
    req('MONIZE_DB_PORT');
    req('MONIZE_DB_NAME');
    req('MONIZE_DB_USER');

    // 3a. JWT secret length (the app enforces >= 32 at startup; catch it early).
    if ((config.MONIZE_JWT_SECRET || '').length < 32) {
      problems.push('MONIZE_JWT_SECRET must be at least 32 characters (the app enforces this at boot).');
    }

    // 3b. Production / remote database guards (only meaningful once a host is set).
    if (config.MONIZE_DB_HOST) {
      if (isProdLike(config.MONIZE_DB_NAME) || isProdLike(config.MONIZE_DB_HOST)) {
        problems.push(
          `The database (${config.MONIZE_DB_HOST}/${config.MONIZE_DB_NAME}) looks like PRODUCTION. ` +
            'Refusing. Restore a copy into a throwaway database and point MONIZE_DB_* at that.',
        );
      }
      if (!LOCAL_HOSTS.has(config.MONIZE_DB_HOST) && config.MONIZE_ALLOW_REMOTE_DB !== 'yes') {
        problems.push(
          `MONIZE_DB_HOST "${config.MONIZE_DB_HOST}" is not local. A remote database is a strong signal ` +
            'you are about to read something you should not. Set MONIZE_ALLOW_REMOTE_DB=yes only if you are certain.',
        );
      }
    }

    // 3c. Docker present.
    try {
      execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' });
    } catch {
      problems.push('Docker does not appear to be available/running, which Docker mode requires.');
    }
  } else {
    info('URL mode: MONIZE_BEFORE_URL and MONIZE_AFTER_URL are set; the harness will NOT start any containers.');
    if (config.MONIZE_BEFORE_URL === config.MONIZE_AFTER_URL) {
      problems.push('MONIZE_BEFORE_URL and MONIZE_AFTER_URL are identical; there would be nothing to compare.');
    }
  }

  // 4. Comparing a revision to itself is almost never intended.
  if (mode === 'docker' && config.MONIZE_BEFORE_REF && config.MONIZE_BEFORE_REF === config.MONIZE_AFTER_REF) {
    warn('MONIZE_BEFORE_REF equals MONIZE_AFTER_REF; the comparison should show zero differences.');
  }
  if (config.MONIZE_DB_PASSWORD === '' && mode === 'docker') {
    warn('MONIZE_DB_PASSWORD is empty. That is fine only if your copy DB genuinely has no password.');
  }

  if (problems.length > 0) {
    fail(
      `Preflight failed (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  }

  info(`Preflight OK. Mode: ${mode}.`);
  return { mode, config };
}

// Run directly: `npm run preflight`.
if (import.meta.url === `file://${process.argv[1]}`) {
  runPreflight();
  info('Environment looks safe to run. (This command only checks; it starts nothing.)');
}
