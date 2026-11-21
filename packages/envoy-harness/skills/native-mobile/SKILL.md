---
name: native-mobile
description: Native iOS (Xcode/XCUITest) and Android (Gradle/Espresso) debug loops with device_* tools.
when-to-use: When debugging native Swift/Kotlin apps, Xcode schemes, Gradle connected tests, or XCUITest/Espresso without Flutter/RN.
---

# Native mobile loop

## Prerequisites

- `--permission-preset mobile` for network + CoreSimulator / Android SDK writable roots and `device_*` tools.
- Use jobs/PTY for `xcodebuild` / Gradle — they routinely exceed a single tool timeout.

## iOS

1. `device_list` (platform ios) → UDID.
2. `device_boot` → wait ready.
3. Build/test: `device_test` with `runner: xcodebuild`, `scheme: <Scheme>`, `device_id: <UDID>` — or `xcodebuild test -scheme … -destination 'platform=iOS Simulator,id=…'` in a job.
4. Install a built `.app`: `device_install` then `device_launch` with the bundle id.
5. Observe: `device_screenshot`; UI tree via `idb` when installed (`device_ui_tree`).

## Android

1. `device_list` (platform android) → serial / emulator.
2. `device_boot` (AVD name or serial) → wait ready.
3. `./gradlew installDebug` / `connectedDebugAndroidTest` via `device_test` (`runner: gradle`) or a background job.
4. `device_install` for a `.apk`; `device_launch` with `package` or `package/activity`.
5. `device_screenshot` + `device_ui_tree` (uiautomator dump).

## Tips

- Prefer structured `device_*` for lifecycle; use `bash` for one-off SDK flags.
- Gate stays closed on default sandboxes — never assume Simulator paths are writable without the mobile preset.
