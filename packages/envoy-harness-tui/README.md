# @envoymesh/envoy-harness-tui

Terminal host for **envoy-harness** — Codex-style interaction (composer,
transcript, approvals, slash commands) over the ACP dialect.

Package 1 stays UI-free; this sibling package is host **12a**. EnvoyMesh
Tauri (**12b**) will reuse the same ACP/SDK client later.

## Quick start

```bash
pnpm --filter @envoymesh/envoy-harness-tui test
pnpm --filter @envoymesh/envoy-harness-tui exec tsx src/bin.ts
```

Default binary uses an **in-process demo backend**. Attaching to a live
harness `--acp` stdio process lands when that CLI entry exists.

## Programmatic

```ts
import { createInProcessTui } from "@envoymesh/envoy-harness-tui";

const tui = createInProcessTui();
await tui.session.start();
await tui.session.submit("hello");
console.log(tui.session.renderTranscript());
tui.close();
```
