/**
 * Temp-directory teardown for tests that hold a `PersistedSession`.
 *
 * **The flake this exists to kill.** `PersistedSession` publishes through
 * `DurableLineWriter`, whose `rewrite()` path is *atomic*: it writes
 * `<file>.rewrite-<pid>.tmp`, fsyncs it, renames it over the target, then
 * fsyncs the directory. All of that is asynchronous and batched (25 ms by
 * default).
 *
 * A test that creates a session, calls `setTitle()` (or just
 * `appendMessage()`), and then tears the directory down straight away can
 * therefore race a still-in-flight write. `rm -rf` walks the directory,
 * finds the `.tmp` file that appeared between its readdir and its rmdir,
 * and `rmdir` fails:
 *
 * ```
 * Error: ENOTEMPTY: directory not empty, rmdir '/tmp/envoy-persisted-test-XXXX'
 * ```
 *
 * The test body passed; the *teardown* threw, which vitest reports as a
 * failed test. That is a false negative that only shows up under load —
 * exactly the kind of "1 in 8 full-suite runs fails one test" noise that
 * trains people to re-run instead of investigate.
 *
 * **Two fixes, both applied.** Prefer closing the session (that is the
 * product's own contract — see `Session.close`); use this helper as the
 * backstop for the many tests whose subject is the writer rather than the
 * lifecycle, and for the `.tmp` file that can appear at any moment.
 *
 * `maxRetries` is the documented Node behaviour for `ENOTEMPTY` /
 * `EBUSY` / `EPERM` on `fs.rm`; without it the default is zero retries.
 */

import { rm } from "node:fs/promises";

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 25,
  });
}
