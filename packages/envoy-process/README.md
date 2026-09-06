# @envoymesh/envoy-process

Tiny shared helpers used by `@envoymesh/envoy-harness` and
`@envoymesh/envoy-sandbox-win`.

## `killProcessTree(pid)`

Best-effort process-tree kill:

- **win32:** `taskkill /PID <pid> /T /F`
- **elsewhere:** `process.kill(pid, "SIGKILL")`

Never throws; invalid / missing pids are no-ops.
