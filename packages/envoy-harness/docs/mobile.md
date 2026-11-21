# Mobile app agent capabilities

Envoy-harness can drive **Flutter / React Native / native** loops on a local
Mac (iOS Simulator + Android Emulator), with optional remote device workers
over the existing mesh.

## Permission preset

```bash
envoy-harness --permission-preset mobile --repl
# or in config.toml:
# permission_preset = "mobile"
# or REPL: /preset mobile
```

The `mobile` preset sets:

- `permissionMode = workspace-write`
- `askForApproval = on-request`
- `autoRun = safe-only`
- `networkAccess = true`
- extra `writableRoots`: CoreSimulator, Xcode, Android SDK/AVD, project `build/`

`device_*` tools are gated: they require this preset (mobile roots),
`danger-full-access` / approve-all, or `ENVOY_MOBILE_TOOLS=1`.

## Device tools

| Tool | Role |
|---|---|
| `device_list` | iOS `simctl` + Android `adb devices` |
| `device_boot` | Boot/shutdown; wait-until-ready |
| `device_install` | `.app` / `.apk` / `flutter install` |
| `device_launch` | Bundle id / Android activity |
| `device_screenshot` | PNG → **vision** multimodal tool result |
| `device_ui_tree` | Android uiautomator dump; iOS via `idb` when installed |
| `device_test` | `xcodebuild` / `flutter test` / Gradle / Maestro / Detox |

Long boots and builds should use existing **jobs / PTY** (`bash` background,
`job_*`, `terminal_*`) — the mobile skills document that pattern.

## Skills

Bundled under `packages/envoy-harness/skills/`:

- `flutter-mobile`
- `react-native-mobile`
- `native-mobile`

Loaded via the package skill root (`package:envoy`) in addition to project /
user skill directories.

## Vision bridging

MCP and first-party tool results that include images are no longer collapsed
to `[image …]` text placeholders. They become multimodal content:

- Anthropic: images inside `tool_result` content blocks
- OpenAI-compatible: tool text + follow-up user `image_url` parts

## Remote device worker (mesh)

On a Mac with Xcode / Android SDK:

```bash
# Advertise capability device-worker (mDNS optional)
envoy-peer serve --port 8123 --peer-id mac-lab \
  --adapter ./path-to-envoy-harness-adapter.mjs \
  --device-worker --advertise
```

Laptop agent:

```bash
envoy-harness --repl --peers mac-lab@192.168.1.10:8123 --permission-preset mobile
```

Route long UI tests with `task` toward capability `device-worker` / skill
`device-debug` (`preferred_peer_id` or capability tag). Helpers live in
`src/mobile/device-worker.ts`.

## Smoke test

```bash
ENVOY_MOBILE_SMOKE=1 pnpm --filter @envoymesh/envoy-harness test test/mobile/smoke.darwin.test.ts
```
