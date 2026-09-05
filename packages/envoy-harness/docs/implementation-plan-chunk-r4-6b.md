# Chunk R4.6b — Skill fuzzy ranker

> **Status:** IMPLEMENTED (2026-09-06).
> Part of Round 4 D-Refine ([`implementation-plan-round-4.md`](./implementation-plan-round-4.md)).

## Goal

Ranked skill suggest for `/` UX: **prefix > fuzzy > catalog order**.

## Changes

- `src/skills/ranker.ts` — `rankSkills`, `isSubsequenceMatch`
- TUI `skill-suggest.ts` — `matchingSkillSuggestions` (user-invocable)
- Hermetic tests in `test/skills/ranker.test.ts`

## Accept

- [x] Prefix matches rank first
- [x] Hermetic ranker tests

## Out of scope

- Full TUI palette wiring to live `SkillRegistry` (helper is ready)
- EHUI EnvoyMesh panel (consumes same `rankSkills` export)
