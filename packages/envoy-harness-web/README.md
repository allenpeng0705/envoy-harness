# `@envoymesh/envoy-harness-web`

Browser WebUI for standalone `envoy-harness` (ACP over WebSocket).

```sh
pnpm --filter @envoymesh/envoy-harness-web start
# or
envoy-harness web
```

Opens a local HTTP server + WebSocket ACP proxy that spawns
`envoy-harness --acp` per browser connection.
