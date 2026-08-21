# @envoymesh/envoy-harness-client

TypeScript stdio client for the envoy-harness **ACP** (automation)
and **SDK** (embedding) JSON-RPC dialects.

```ts
import {
  EnvoyHarnessClient,
  spawnAcpServer,
} from "@envoymesh/envoy-harness-client";

// Attach to an existing stdio pair…
const client = new EnvoyHarnessClient({
  input: process.stdin,
  output: process.stdout,
  onPermissionRequest: async () => "allow",
});

// …or spawn `envoy-harness --acp` as a child:
const spawned = spawnAcpServer({
  args: ["--acp"],
  onPermissionRequest: async () => "allow",
});

await spawned.client.initialize();
const { sessionId } = await spawned.client.acpNewSession();
const result = await spawned.client.prompt(sessionId, "hello");
spawned.close();
```

Shares the Content-Length JSON-RPC codec with `@envoymesh/envoy-harness`
(`src/protocol/`). Python SDK is deferred until a consumer exists.

See also: Package 1 `envoy-harness --acp`, TUI `--spawn`, and
[`docs/tauri-acp-host.md`](../envoy-harness/docs/tauri-acp-host.md) for EnvoyMesh.
