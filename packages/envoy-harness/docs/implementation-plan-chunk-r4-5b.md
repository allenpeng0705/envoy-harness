# Chunk R4.5b — Permission presets

> **Status:** IMPLEMENTED (2026-09-05).
> Part of Round 4 D-Refine ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).

## Goal

One UI/config control = sandbox mode + approval + auto-run policy
(dsh / EnvoyGo “keep it simple”).

## Changes

### Core

- `src/permissions/presets.ts` — `safe` / `ask-all` / `approve-all`
- `src/permissions/index.ts` — public re-exports (+ auto-run helpers)
- `ConfigLayer.permissionPreset` + `autoRun`; TOML `permission_preset` /
  `auto_run`
- `resolveAgentRuntimeConfig` expands preset (explicit fields override)
- `Agent.setPermissionPreset` / `getPermissionPreset`
- ACP/SDK `session/set_policy` accepts `preset`
- REPL `/preset <name>`; `/status` shows matched preset

### Preset map

| Preset | Sandbox | Approval | Auto-run |
|---|---|---|---|
| `safe` | read-only | unless-trusted | always-confirm |
| `ask-all` | workspace-write | on-request | always-confirm |
| `approve-all` | danger-full-access | never | off |

### Later extensions (shipped)

| Preset | Same axes as | Extra |
|---|---|---|
| `mobile` | ask-all-like write + `safe-only` + network | Simulator/SDK roots → `device_*` — [`mobile.md`](./mobile.md) |
| `webdev` | same as `mobile` | Vite/Next/Playwright caches → `browser_*` — [`webdev.md`](./webdev.md) |

`mobile` / `webdev` share mode/approval/autoRun; hosts track the **named**
preset (`Agent.permissionPresetName` / ACP `get_policy`) instead of
inferring from axes alone. ACP/SDK `session/set_policy` accepts all five
names.

## Tests

- `test/permissions/presets.test.ts` — resolve/match, config round-trip,
  TOML load, override precedence
- `test/mobile/preset.test.ts`, `test/web/preset.test.ts` — domain roots + gates

## Accept

- [x] Preset round-trip in config
- [x] UI can set one value (`/preset`, `session/set_policy` `{ preset }`)
- [x] `mobile` / `webdev` expand roots + unlock domain tools

## Out of scope

- Custom user-defined preset files under `$ENVOY_HOME`
- EnvoyGo native menu chrome (uses the same preset names)
