# Mobile app agent capabilities

Envoy-harness can drive **Flutter / React Native / native** loops on a local
Mac (iOS Simulator + Android Emulator), with optional remote device workers
over the existing mesh.

For Vite / Next / SPA browser loops, see [`webdev.md`](./webdev.md).

## Permission preset

```bash
envoy-harness --permission-preset mobile --repl
# or in config.toml:
# permission_preset = "mobile"
# or REPL: /preset mobile
# or ACP/SDK: session/set_policy { "preset": "mobile" }
```

The `mobile` preset sets:

| Axis | Value |
|---|---|
| `permissionMode` | `workspace-write` |
| `askForApproval` | `on-request` |
| `autoRun` | `safe-only` |
| `networkAccess` | `true` |
| Extra `writableRoots` | CoreSimulator, Xcode, XCTestDevices, Android SDK / `~/.android` / AVD, project `build/`, `android/…/build`, `ios/build`, `.dart_tool` |

### Gating `device_*`

Tools run only when one of these is true:

1. Sandbox writable roots include a **high-signal** mobile marker
   (CoreSimulator / Xcode / Android SDK / `.android` / AVD / `.dart_tool` /
   `android/…/build` / `ios/build`), **or**
2. `permissionMode = danger-full-access` / `approve-all`, **or**
3. `ENVOY_MOBILE_TOOLS=1`

A bare path that merely ends in `/build` (for example a project cwd named
`build`) does **not** unlock the tools.

`mobile` and `webdev` share sandbox/approval/auto-run axes. Prefer the named
preset from `Agent.getPermissionPreset` / ACP `get_policy`.

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

| Skill | When |
|---|---|
| `flutter-mobile` | Flutter + Simulator/Emulator |
| `react-native-mobile` | Metro + Detox / Maestro |
| `native-mobile` | Xcode / Gradle / Espresso |

Loaded via the package skill root (`package:envoy`) in addition to project /
user skill directories.

## Vision bridging

MCP and first-party tool results that include images are no longer collapsed
to `[image …]` text placeholders. They become multimodal content:

- Anthropic: images inside `tool_result` content blocks
- OpenAI-compatible: tool text + follow-up user `image_url` parts

WebUI renders those images in the transcript.

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
`device-debug` (`preferred_peer_id` or capability tag). Helpers:
`src/mobile/device-worker.ts`. Adapter skill mapping:
`@envoymesh/envoy-harness-adapter` → `device-debug`.

See also [`distributed-collaboration.md`](./distributed-collaboration.md) §1.2.

## Smoke test

```bash
ENVOY_MOBILE_SMOKE=1 pnpm --filter @envoymesh/envoy-harness test test/mobile/smoke.darwin.test.ts
```
