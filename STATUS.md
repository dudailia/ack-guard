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

- Review round 3 fixes (commit 5885950): port/scheme duplicate bypass, emptied-log restart, numbers re-derived from the signed log (`verifyRun`), approvals outside the payment lock, receipts bound to the quoted resource, splitting attacks that hit the cumulative caps. 77 tests.
- Pre-fix run committed and marked superseded; the first attempt at the final run was stopped at 41/450 when review 3 found behavior-affecting issues (moved to `.data/aborted-final-20261116`, not used).

## In progress
2. Final benchmark running at commit 5885950: `results/qwen3-8b/final-20261116/`, log `.data/bench-final.log`.
   If interrupted: `git checkout 5885950 -- src && pnpm redteam --model qwen3:8b --runs 5 --resume results/qwen3-8b/final-20261116` (it refuses if src changed).
3. After it: `pnpm report`, dashboard screenshot, `pnpm record-demo` with qwen3, MEMO and LinkedIn, review round 2, full checks.

## Waiting on the user
- Claude runs need `ANTHROPIC_API_KEY` in `.env` (gitignored).
