# STATUS

Last updated: 2026-11-15 (build in progress)

## Done (committed)
- M0 scaffold, pinned `agentcommercekit@0.11.0`, ACK API spike (`pnpm spike`)
- M1 identities (ACK-ID), sandbox ledger, ACK-Pay receipt service, 5 merchants
- M2 policy engine (12 ordered rules) and tests
- M3 hash-chained signed audit log, signed head, `pnpm replay`, `pnpm verify-log`, tamper tests
- M4 agents (naive and guarded share one code path), 35 attacks plus 8 benign tasks, runner, scoring

## In progress
- M5 qwen3:8b benchmark: `results/qwen3-8b/run-<date>/` (log in `.data/bench-qwen.log`).
  Resume if interrupted: `pnpm redteam --model qwen3:8b --runs 3 --resume results/qwen3-8b/run-<date>`
- M6 dashboard, M7 docs

## Next
- Claude runs need `ANTHROPIC_API_KEY` in `.env` (gitignored). Waiting on the user for that.
