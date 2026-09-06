# @envoymesh/envoy-process

Shared process helpers for the envoy-harness monorepo. Exists so
`@envoymesh/envoy-harness` and `@envoymesh/envoy-sandbox-win` can share
`killProcessTree` without a circular package edge.

## Exports

### `killProcessTree(pid)`

Best-effort process-tree kill:

- **win32:** `taskkill /PID <pid> /T /F`
- **elsewhere:** `process.kill(pid, "SIGKILL")`

Never throws; invalid / missing pids are no-ops.
