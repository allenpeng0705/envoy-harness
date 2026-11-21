---
name: react-native-mobile
description: Debug React Native apps with Metro, adb/simctl, device_* tools, Detox or Maestro.
when-to-use: When working on a React Native / Expo app, debugging native UI on Simulator or Emulator, or running Detox/Maestro flows.
---

# React Native mobile loop

## Prerequisites

- `--permission-preset mobile` (unlocks `device_*` + SDK/Simulator writable roots).
- Start Metro in a background job (`npx react-native start` or `npx expo start`) — do not hold the agent turn on the packager.

## Standard loop

1. `device_list` → choose iOS Simulator UDID or Android serial.
2. `device_boot` if needed; wait until ready.
3. Install/run: `npx react-native run-ios --udid <id>` / `run-android` via `bash` (background), or Expo `npx expo run:ios` / `run:android`.
4. Iterate UI with `device_screenshot` (vision) after each change.
5. UI automation when present:
   - Maestro: `device_test` with `runner: maestro` and `extra_args` pointing at a flow.
   - Detox: `device_test` with `runner: detox` (or `npx detox test` in a job).
6. Android hierarchy: `device_ui_tree`. iOS: install `idb` or rely on screenshots + Detox.

## Tips

- Clear Metro cache only when needed (`--reset-cache`) — expensive.
- Use `adb logcat` / `xcrun simctl spawn … log` via `bash` for crash stacks; keep filters tight.
- Remote Mac with Xcode: submit long builds/UI tests to a mesh peer advertising capability `device-worker`.
