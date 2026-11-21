---
name: flutter-mobile
description: Debug and ship Flutter apps with device_* tools, flutter CLI, and background jobs.
when-to-use: When working on a Flutter project (pubspec.yaml), running on iOS Simulator or Android Emulator, or fixing Flutter UI bugs with screenshots.
---

# Flutter mobile loop

## Prerequisites

- Use `--permission-preset mobile` (or `/preset mobile`) so Simulator/SDK roots and `device_*` tools are allowed.
- Long boots/builds: prefer `bash` with background jobs / `job_*` / PTY — do not block the turn on multi-minute Gradle/Xcode compiles.

## Standard loop

1. `device_list` — pick an iOS UDID or Android serial.
2. `device_boot` — boot and wait until ready (or use an already-booted device from `flutter devices`).
3. From the project root: `flutter pub get`, then `flutter run -d <id>` via `bash` (background for long runs).
4. After UI changes: `device_screenshot` — inspect the vision image, then act.
5. For widget/integration tests: `device_test` with `runner: flutter`, or `flutter test` / `flutter test integration_test`.
6. Optional: `device_ui_tree` on Android; on iOS install `idb` for accessibility dumps.

## Tips

- Prefer `device_screenshot` over describing pixels from memory.
- Keep Metro/Flutter attach in a job; use `device_launch` only when installing a built artifact.
- If CLIs are missing, tool errors name Xcode CLT / Android SDK / Flutter — install those on the host (or route to a mesh `device-worker` peer).
- Full reference: `docs/mobile.md`.
