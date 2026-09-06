# Round 5 — Wire seams + product shell

> **Status:** IMPLEMENTED (2026-09-06). R5.1–R5.6 landed (wire seams +
> U6a remainder).
> **Design:** [`distributed-collaboration.md`](./distributed-collaboration.md) §1 + §11–12.
> **Master index:** [`implementation-plan.md`](./implementation-plan.md) §Distributed.
> **Prior round:** [`implementation-plan-round-4.md`](./implementation-plan-round-4.md) (IMPLEMENTED).

## Framing (after R4)

R4 delivered **contracts + hermetic fakes** for remote jobs, exec-world,
discovery rail, and continuable peers. Round 5 makes those seams **live
on the wire** and finishes the remaining U6a TUI product-shell slices.

| Deferred in R4 | Round 5 chunk |
|---|---|
| Live `jobs/*` JSON-RPC | **R5.1** |
| Live `peer/exec/*` RPC | **R5.2** |
| CLI `--discovery=…` wiring | **R5.3** |
| Adapter / EnvoyMesh transport swap | **R5.4** |
| U6a.4 permission scroll | **R5.5** |
| U6a.5 resume + image hint | **R5.6** |

**Lead:** Wire seams first (differentiator demoable without fakes).
U6a remainder interleaved as small TUI-only commits.

**Per-chunk discipline:** `implementation-plan-chunk-r5-*.md` + code +
tests + commit.

---

## Phase map

| Phase | Theme | Chunks | Serves |
|---|---|---|---|
| **R5-Wire** | Live peer RPC + discovery CLI + adapter | R5.1–R5.4 | Multi-node / EnvoyMesh |
| **R5-Shell** | U6a remainder | R5.5–R5.6 | Terminal daily driver |

```
R5.0 plan doc
    │
    ├─► R5.1 jobs RPC ─► R5.2 exec RPC ─► R5.3 discovery CLI ─► R5.4 adapter
    │
    └─► R5.5 U6a.4 ─► R5.6 U6a.5   (parallel with wire after R5.0)
```

---

## R5-Wire

### R5.1 — Peer `jobs/*` RPC + live `RemoteJobTransport`

| | |
|---|---|
| **Why** | R4.12 left live JSON-RPC out of scope; fakes only. |
| **Where** | `envoy-harness-peer` messages/server/client; transport implementing Package-1 `RemoteJobTransport` |
| **Deliver** | `peer/jobs/fetch` / `read` / `kill` / `list`; `createPeerRemoteJobTransport` |
| **Accept** | Hermetic in-process peer pair; Package 1 stays network-free |

### R5.2 — Peer `exec/*` RPC + live `RemoteExecTransport`

| | |
|---|---|
| **Why** | R4.14b deferred live `peer/exec/*`. |
| **Where** | peer RPC + `createPeerRemoteExecTransport` → `createPeerExecWorld` |
| **Deliver** | `peer/exec/read` / `write` / `shell` (no background peer bash) |
| **Accept** | Coordinator `execWorld` hits peer FS/shell over JSON-RPC |

### R5.3 — Discovery rail on CLI / ACP

| | |
|---|---|
| **Why** | R4.18 rail exists; CLI still static `connectPeers` only. |
| **Where** | `wirePeerCluster`, argv `--discovery`, ACP + TUI cluster wiring |
| **Deliver** | `--discovery static\|mdns\|none` (default `static`); rail + static source |
| **Accept** | Static path unchanged; hermetic fake rail still works |

### R5.4 — Adapter job/exec transport factories

| | |
|---|---|
| **Why** | EnvoyMesh hosts need the same swap pattern as submit transport. |
| **Where** | `envoy-harness-adapter`; short doc note for host mapper swap |
| **Deliver** | Factories wrapping peer client transports for jobs + exec |
| **Accept** | Adapter exports usable without Package 1 network imports |

---

## R5-Shell

### R5.5 — U6a.4 Permission modal polish

Scrollable bordered permission + diff preview in screen/UI layer;
hermetic screen tests. (U6a.2–3 already shipped.)

### R5.6 — U6a.5 Resume picker + image composer hint

`/resume` picker panel; composer hint for image blocks. No Ink/Blessed.

---

## Non-goals (Round 5)

- U6b EHUI React dock (EnvoyMesh / EnvoyGo)
- F2 Windows sandbox
- Auto-route `edit` / `git` through exec-world; background peer bash
- Real OS Bonjour (injectable browser only)
- Libp2p job fabric beyond peer JSON-RPC

---

## Tracking table

| Chunk | Phase | Priority | Status |
|---|---|---|---|
| R5.0 Plan artifacts | — | P0 | **done** |
| R5.1 Peer jobs RPC | R5-Wire | **P0** | **done** |
| R5.2 Peer exec RPC | R5-Wire | **P0** | **done** |
| R5.3 Discovery CLI | R5-Wire | **P0** | **done** |
| R5.4 Adapter transports | R5-Wire | P1 | **done** |
| R5.5 U6a.4 permission | R5-Shell | P1 | **done** |
| R5.6 U6a.5 resume/images | R5-Shell | P1 | **done** |

---

## Success criteria

- Peer cluster: remote job fetch/kill and peer exec read/shell over live JSON-RPC (hermetic pair CI)
- `envoy-harness --peers …` uses discovery rail; `--discovery` documented
- Adapter exports live job/exec transports for EnvoyMesh to swap in
- TUI: permission UX scrollable; `/resume` picker usable without `/help`
- Package 1 remains EnvoyMesh-free; no live LLM in CI
