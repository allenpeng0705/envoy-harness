/**
 * Host-addressing helpers for the WebUI server.
 *
 * Kept separate from `start.ts` so they can be unit-tested without pulling
 * in Vite and the whole HTTP host.
 */

/** True for the addresses that are only reachable from this machine. */
export function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}
