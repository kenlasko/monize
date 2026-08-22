import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { HARNESS_ROOT, REPO_ROOT, info, warn, fail } from './env.mjs';

const COMPOSE_FILE = resolve(HARNESS_ROOT, 'docker-compose.regression.yml');
const WORKTREES_DIR = resolve(HARNESS_ROOT, '.worktrees');

function sanitize(ref) {
  return ref.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) throw res.error;
  if (typeof res.status === 'number' && res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with ${res.status}`);
  }
  return res;
}

/**
 * Check a git ref out into an isolated worktree so both revisions can be built
 * from one clone without disturbing the working tree. Returns the worktree path.
 */
export function prepareWorktree(ref) {
  mkdirSync(WORKTREES_DIR, { recursive: true });
  const path = resolve(WORKTREES_DIR, sanitize(ref));
  if (existsSync(path)) {
    // Reuse if present; refresh it to the ref's current tip.
    run('git', ['-C', path, 'checkout', '--detach', ref], { cwd: REPO_ROOT }).status;
  } else {
    try {
      run('git', ['worktree', 'add', '--force', '--detach', path, ref], { cwd: REPO_ROOT });
    } catch (err) {
      fail(
        `Could not create a git worktree for ref "${ref}": ${err.message}\n` +
          `Fetch it first (e.g. \`git fetch origin ${ref}\`) or check the ref name.`,
      );
    }
  }
  return path;
}

/** Environment for a compose invocation of one phase. */
function composeEnv(config, context) {
  return {
    ...process.env,
    MONIZE_APP_CONTEXT: context,
    MONIZE_DB_HOST: config.MONIZE_DB_HOST,
    MONIZE_DB_PORT: config.MONIZE_DB_PORT,
    MONIZE_DB_NAME: config.MONIZE_DB_NAME,
    MONIZE_DB_USER: config.MONIZE_DB_USER,
    MONIZE_DB_PASSWORD: config.MONIZE_DB_PASSWORD ?? '',
    MONIZE_JWT_SECRET: config.MONIZE_JWT_SECRET,
    MONIZE_AI_ENCRYPTION_KEY: config.MONIZE_AI_ENCRYPTION_KEY ?? '',
    MONIZE_FRONTEND_PORT: config.MONIZE_FRONTEND_PORT || '4801',
    MONIZE_BACKEND_PORT: config.MONIZE_BACKEND_PORT || '4800',
  };
}

function projectName(phase) {
  return `monize-regr-${phase}`;
}

/**
 * Build and start one revision, blocking until healthy. Fails loudly if the
 * build or boot fails. Returns a handle for stopRevision.
 */
export function startRevision({ phase, ref, config }) {
  const context = prepareWorktree(ref);
  const project = projectName(phase);
  const env = composeEnv(config, context);

  info(`[${phase}] building & starting revision "${ref}" (project ${project})...`);
  try {
    run(
      'docker',
      [
        'compose',
        '-p',
        project,
        '-f',
        COMPOSE_FILE,
        'up',
        '-d',
        '--build',
        '--wait',
        '--wait-timeout',
        '900',
      ],
      { env },
    );
  } catch (err) {
    // Surface container logs to make a boot failure diagnosable, then abort.
    warn(`[${phase}] revision failed to start; dumping recent logs:`);
    spawnSync('docker', ['compose', '-p', project, '-f', COMPOSE_FILE, 'logs', '--tail', '80'], {
      stdio: 'inherit',
      env,
    });
    stopRevision({ phase, env });
    fail(`[${phase}] could not start revision "${ref}": ${err.message}`);
  }

  const url = `http://localhost:${env.MONIZE_FRONTEND_PORT}`;
  info(`[${phase}] revision "${ref}" healthy at ${url}`);
  return { phase, project, env, url, context };
}

/** Stop and remove a revision's containers/network. Never touches the DB. */
export function stopRevision(handle) {
  if (!handle) return;
  const { phase, project, env } = handle;
  info(`[${phase}] stopping revision (project ${project})...`);
  // `down` removes the app containers and the compose network. There are no
  // compose-managed volumes (the DB is external), so nothing persistent is lost.
  spawnSync('docker', ['compose', '-p', project, '-f', COMPOSE_FILE, 'down', '--remove-orphans'], {
    stdio: 'inherit',
    env: env ?? process.env,
  });
}

/** Remove a worktree created by prepareWorktree (best-effort). */
export function cleanupWorktree(handle) {
  if (!handle?.context) return;
  spawnSync('git', ['worktree', 'remove', '--force', handle.context], {
    stdio: 'ignore',
    cwd: REPO_ROOT,
  });
  try {
    if (existsSync(handle.context)) rmSync(handle.context, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
