"use strict";

/*
 * The desktop shell's orphan guard. The supervisor loads this file into every
 * backend and frontend process it starts (`node --require <this file> ...`,
 * see desktop/src/supervisor/parent-watch.ts) and gives each one a stdin pipe
 * that it never writes to and never closes. When the shell dies for any
 * reason, a crash or Task Manager included, the operating system closes its
 * end of that pipe; this process then reads end-of-file on stdin and exits.
 * Without it a killed shell would leave the backend and the frontend running
 * and holding the persisted ports, and the next launch would have to move
 * them, which changes the application's origin (plan decision D8).
 *
 * It is desktop-owned and changes no layer file: the backend and the frontend
 * stay byte-identical to what the containers run. Neither layer reads stdin.
 *
 * - It does nothing unless stdin is a pipe or a socket (a terminal, a file,
 *   /dev/null or NUL are left alone), and nothing in a worker thread.
 * - It never keeps the process alive: the stdin handle is unreferenced, so a
 *   script that finishes on its own exits exactly as it would without this
 *   file, with its own exit code.
 * - It says nothing before exiting. The only place its output could go is a
 *   pipe to the shell that has just died; the next launch's log records the
 *   ports it found busy.
 *
 * Exiting mid-step is as safe as the kill `stop()` already sends (see the
 * header of desktop/src/supervisor/child.ts): the backend keeps its durable
 * state in PostgreSQL, `dist/db-init.js` sends schema.sql as one batch and
 * `dist/db-migrate.js` runs each migration between BEGIN and COMMIT with its
 * ledger row, so the dropped connection rolls back whatever was in flight and
 * releases the advisory lock; the next boot runs the step again from a clean
 * state. A migration abandoned by a dead shell is therefore stopped, not left
 * running unobserved against the next boot.
 */

const net = require("net");
const { isMainThread } = require("worker_threads");

/** Nobody is left to read it; it only has to differ from success. */
const PARENT_GONE_EXIT_CODE = 1;

function watchParent() {
  if (!isMainThread) return;
  const stdin = process.stdin;
  // Node makes stdin a `net.Socket` exactly when fd 0 is a pipe or a socket;
  // a terminal is a `tty.ReadStream`, which is a socket too, so it is excluded.
  if (!(stdin instanceof net.Socket) || stdin.isTTY) return;
  const exit = () => process.exit(PARENT_GONE_EXIT_CODE);
  stdin.once("end", exit);
  stdin.once("close", exit);
  stdin.once("error", exit);
  // Reading is what reports end-of-file. Nothing is ever written to the pipe;
  // were anything written, it would be discarded here.
  stdin.resume();
  stdin.unref();
}

watchParent();
