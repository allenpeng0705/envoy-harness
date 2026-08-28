# @envoymesh/envoy-harness-ehui

React EHUI side panel for **EnvoyGo / EnvoyMesh** — same data contract as
`envoy-harness-tui`, via `@envoymesh/envoy-harness-client` (`createEhuiDataSource`).

## Usage (EnvoyMesh `apps/social`)

```tsx
import {
  EhuiShell,
  type EhuiPanelId,
} from "@envoymesh/envoy-harness-ehui";
import { createEhuiDataSource } from "@envoymesh/envoy-harness-client";

const ehui = createEhuiDataSource(client, sessionId);

<EhuiShell
  dataSource={ehui}
  activePanel="plan"
  onPanelChange={(id) => setPanel(id)}
/>
```

Wire next to Pi chat when `codingBackend === "envoy-harness"`. See
`packages/envoy-harness/docs/ehui-panel-spec.md`.
