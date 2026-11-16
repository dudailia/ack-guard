# STATUS

Last updated: 2026-11-15, late evening.

## Done (committed locally, nothing pushed)
- M0 scaffold, pinned `agentcommercekit@0.11.0`, ACK API spike (`pnpm spike`)
- M1 identities (ACK-ID), sandbox ledger, ACK-Pay receipt service, 5 merchants
- M2 policy engine (12 ordered rules) and tests
- M3 hash-chained signed audit log, signed head, `pnpm replay`, `pnpm verify-log`, tamper tests
- M4 agents (naive and guarded share one code path), 35 attacks plus 8 benign tasks, runner, scoring, runner tests
- M6 dashboard (`pnpm demo`, http://localhost:4300) with scoreboard, live timeline, replay, tamper demo, approvals
- M7 README, WALKTHROUGH, NOTICE, LICENSE, generated results table (`pnpm report`)
- Verified from a fresh clone: `pnpm install && pnpm check` passes (45 tests); `pnpm demo` and `pnpm replay` work

## In progress
- M5 qwen3:8b benchmark, 258 episodes: `results/qwen3-8b/run-20261115/`, log in `.data/bench-qwen.log`.
  If interrupted, resume with:
  `pnpm redteam --model qwen3:8b --runs 3 --resume results/qwen3-8b/run-20261115`
  then `pnpm report` and commit the results.
- MEMO-for-Catena.md and LINKEDIN.md get written once the final numbers exist (they quote them).

## Waiting on the user
- Claude runs need `ANTHROPIC_API_KEY` in `.env` (gitignored). Then:
  `pnpm redteam --model claude-sonnet-5-5 --runs 3` and `pnpm report`.
