# `@envoymesh/envoy-harness-peer`

Standalone **TCP peers** for `envoy-harness` — collaborate across machines
**without EnvoyMesh**. Speaks the same MAP message schemas over JSON-RPC
framing.

## Quick start

**Terminal A — worker peer:**

```sh
# From the monorepo root
pnpm --filter @envoymesh/envoy-harness-peer exec \
  tsx bin/envoy-peer.ts serve \
  --port 8123 \
  --peer-id alice \
  --model deepseek-chat
```

Listens on `0.0.0.0:8123` by default.

**Terminal B — client (CLI or WebUI):**

```sh
envoy-harness --repl --peers alice@127.0.0.1:8123 --provider openai --model gpt-4o

# or browser
envoy-harness web --persist --peers alice@127.0.0.1:8123
```

On another machine, replace `127.0.0.1` with the peer’s LAN or public IP.

## CLI

| Command | Purpose |
|---|---|
| `envoy-peer serve` | Listen for MAP-over-JSON-RPC work |
| `envoy-peer ui` | Cluster console TUI over connected peers |

### `serve` flags

| Flag | Default | Meaning |
|---|---|---|
| `--host` | `0.0.0.0` | Bind address |
| `--port` | `8123` | Listen port |
| `--peer-id` | `envoy-peer` | Stable peer id |
| `--model` | — | Advertised model (for routing) |
| `--adapter <file>` | built-in demo | ESM module exporting an `AgentAdapter` |
| `--verify-after-execute` | off | Run verify after each submit |

```sh
envoy-peer serve --help
```

## How it fits

```text
LocalMeshSubmitter  →  PeerMeshSubmitter  →  RemoteMeshSubmitter
   local task              this package         EnvoyMesh (optional)
```

Clients pass `--peers id@host:port` (or `ENVOY_PEERS`). The WebUI Mesh rail
and EHUI Peers/Mesh/Team panels show the connected cluster.

Full walkthrough: [monorepo README — Distributed features](../../README.md#distributed-features-no-envoymesh-required).

## Develop

```sh
pnpm --filter @envoymesh/envoy-harness-peer test
pnpm --filter @envoymesh/envoy-harness-peer typecheck
pnpm --filter @envoymesh/envoy-harness-peer build
```

## License

Apache-2.0
