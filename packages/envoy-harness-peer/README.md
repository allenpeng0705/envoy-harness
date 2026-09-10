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

## LAN discovery (mDNS / DNS-SD)

Peers can find each other without hand-written `--peers` config. The
implementation is zero-dependency (a hand-rolled DNS codec + an
injectable UDP socket) and speaks `_envoy-harness._tcp.local`:

```sh
# Advertise this peer (PTR + SRV + TXT + A, with a TTL=0 goodbye on exit)
envoy-peer serve --port 8123 --peer-id alice --model deepseek-chat --advertise

# Browse from the harness
envoy-harness --repl --discovery mdns
```

The TXT record carries `id`, `model` and `caps`, so `PeerRegistry` can
route a sub-task to a peer that serves the right model.

**Fail-open by design.** Binding 5353 (shared via `reuseAddr` with the
platform responder) and joining 224.0.0.251 can fail — no multicast
route, a hardened sandbox, a locked-down WLAN. When that happens the
browser reports the error through `onError` and stops; the CLI logs a
warning and continues with static peers. Discovery must never take the
harness down.

**`--discovery mdns` with no `--peers` is a supported configuration** —
starting from an empty peer list is the entire point of discovery, and
an earlier revision silently built no cluster in that case.

### Testability

`MdnsBrowser` / `MdnsAdvertiser` take an injectable `socketFactory` and
`scheduler`, so the whole stack is tested hermetically against byte
fixtures and a manual clock — no multicast, no LAN, no timing flake.
