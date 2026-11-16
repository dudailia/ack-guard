# STATUS

Last updated: 2026-11-15, late night. Overnight hardening plan in progress.

## Done (committed locally, nothing pushed)
- M0 to M7 (scaffold, ACK-ID/ACK-Pay sandbox, policy engine, signed audit log, agents, red-team suite, dashboard, docs)
- Review 1 fixes (commit 5696e20): serialized payments, head marker, signer pinning, dashboard CSRF/Host checks, payment_error entries
- Property tests (fast-check) and audit fuzzing (commit 6fcbdd1), mutation-checked
- Dashboard polish and guided demo (commit 4a4c8f6)
- Review 2 fixes (commit 6bae46f, df9e295): verified log reopening, `--expect-head` anchor, run nonce, line-based replay integrity, per-agent daily cap via shared spend store, canonical URLs, per-payment identity check, same-commit resume, benign tasks above the approval threshold
- Video recorder (`pnpm record-demo`) and INTERVIEW-QUIZ.md
- 70 tests passing

## In progress
1. Pre-fix benchmark (3 runs) finishing in `results/qwen3-8b/run-20261115/`. When done: mark it superseded in its meta.json and run `scripts/check-concurrent-payments.ts` on it.
2. Then the final benchmark: `pnpm redteam --model qwen3:8b --runs 5 --out results/qwen3-8b/final-<date>` on a clean commit.
   If interrupted: `pnpm redteam --model qwen3:8b --runs 5 --resume results/qwen3-8b/final-<date>` (it refuses if the code changed).
3. After it: `pnpm report`, dashboard screenshot, `pnpm record-demo` with qwen3, MEMO and LinkedIn, review round 2, full checks.

## Waiting on the user
- Claude runs need `ANTHROPIC_API_KEY` in `.env` (gitignored).
