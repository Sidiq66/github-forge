// Entry point: connects the forge server built by app.ts to the trial
// environment that grades it, and keeps the process alive for exactly the
// length of the trial.
//
// The arrangement between this process and the environment:
//
//   * MAKEFUN_ENV_URL carries the environment's base URL. When it is unset
//     or empty there is nobody to run a trial with, so the process writes
//     to stderr and exits 1 before opening any socket.
//   * The server listens on port 0, letting the kernel pick a free port.
//     Port 8080 belongs to the environment and is never bound here.
//   * The picked port is announced with POST {env}/register and a JSON
//     body of {"port": N}. The environment pairs N with the address the
//     request arrived from and uses that as the entry's base URL from then
//     on. The first announcement wins: a 409 answer means another entry
//     registered first, which is a normal outcome for this process too, so
//     it counts as success. Answers 400 and 405 say the announcement broke
//     the contract; those are fatal. Every other outcome — a refused
//     connection, a timeout, an unexpected status while the environment is
//     still coming up — is retried until one of the above happens.
//   * After registering, the process polls GET {env}/done. The environment
//     answers straight away with {"done": false} while the suite runs and
//     {"done": true} once it has finished, so the wait is a poll loop, not
//     one long-held request. Leaving before "done" abandons the trial, so
//     failed polls are simply retried.
//   * When the trial ends the server is closed and the process exits 0,
//     which is the harness's cue to stop the environment and score the
//     state export it writes.
//
// Both environment calls share a retry policy: a single attempt is given
// up on after 30 seconds, and the pause between attempts starts at
// 250 ms, doubles with each failure, and is capped at 2 seconds.
//
// Nothing is imported here except the app factory: the lifecycle runs on
// platform globals (fetch, timers, process) alone.

import { createApp } from './app.ts';

/** Longest one call to the environment may run before it counts as failed. */
const ATTEMPT_TIMEOUT_MS = 30_000;
/** Pause after the first failed attempt, in milliseconds. */
const FIRST_PAUSE_MS = 250;
/** Ceiling for the pause between attempts, in milliseconds. */
const LONGEST_PAUSE_MS = 2_000;

/** Marks a register answer that ends the process instead of being retried. */
class ContractError extends Error {}

/** The environment's base URL, trailing slashes stripped; '' when unset. */
function envBaseUrl(): string {
  return (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Wait before the next attempt, after `failures` attempts have failed. */
function pauseAfter(failures: number): number {
  const grown = FIRST_PAUSE_MS * 2 ** Math.min(failures, 8);
  return Math.min(LONGEST_PAUSE_MS, grown);
}

/**
 * Announce the bound port to the environment. Returns once the environment
 * holds the announcement (200) or already holds an earlier one (409);
 * throws ContractError on a 400 or 405; retries everything else forever.
 */
async function announcePort(base: string, port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const answer = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        throw new ContractError(`register answered HTTP ${answer.status}: ${await answer.text()}`);
      }
      // Any other status: the environment is not ready yet; retry below.
    } catch (err) {
      if (err instanceof ContractError) throw err;
      // A network error or an attempt that timed out: also retried below.
    }
    await pause(pauseAfter(failures));
  }
}

/** Poll the environment's /done until its body reports the trial is over. */
async function awaitTrialEnd(base: string): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let over = false;
    try {
      const answer = await fetch(`${base}/done`, {
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (answer.ok) {
        const payload: unknown = await answer.json();
        over =
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { done?: unknown }).done === true;
      }
    } catch {
      // Unreachable or unparseable: the trial is not over; keep polling.
    }
    if (over) return;
    await pause(pauseAfter(failures));
  }
}

/** Bind, announce, wait, shut down: the whole life of the entry process. */
async function run(): Promise<void> {
  const base = envBaseUrl();
  if (base === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: no environment to register with\n');
    process.exit(1);
  }

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      resolve();
    });
  });

  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(base, bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitTrialEnd(base);
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
