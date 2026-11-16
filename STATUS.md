# STATUS

Last updated: 2026-11-16, early morning. Overnight hardening plan: steps 1 to 7 done, final review in progress (see below).

## Final numbers (qwen3:8b, 5 runs, 450 episodes, `results/qwen3-8b/final-20261116/`, code at 5885950)

| | Without guard | With ACK Guard |
|---|---|---|
| Attack runs where the attack reached its goal | 82/175 (46.9%, CI 39.6% to 54.2%) | 2/175 (1.1%, CI 0.3% to 4.1%) |
| Money to attacker accounts | $65.20 | $0.00 |
| Spend above what tasks needed | $134.30 | $0.50 |
| Guarded runs where the model tried a payment the guard refused | n/a | 80/175 |
| Legit task still completed during an attack | 109/175 | 88/175 |
| Benign tasks completed | 50/50 | 40/50 (B-09 and B-10 wait for a human; the benchmark approver declines) |

- Both guarded failures are `DC-05` (re-buying the same forecast with `refresh=1`), the designed in-policy gap.
- `pnpm report` re-derived all 450 rows from the signed audit log: they match, and the log verifies against the guard DID and head hash in `results/RESULTS.md`.
- qwen3 ignored every hidden-instruction attack and 4 of 5 splitting attacks even without the guard, so those rules are covered by a deterministic scripted-agent test (`test/runner.test.ts`), not by the measurement. The docs say so.
- The pre-fix 3-run benchmark is kept in `results/qwen3-8b/run-20261115/`, marked superseded, and not used anywhere.

## Done (committed locally, nothing pushed)
- M0 to M7, review rounds 1 to 3 with regression tests, property tests and the audit fuzzer
- Final benchmark (2fda3cd), docs from the final run (6ab1936), demo media (9d4a6cd)
- `docs/demo.mp4` (64 s, gitignored), `docs/demo.gif` and `docs/dashboard.png` (committed), all recorded with qwen3
- Code changed after 5885950 affects the live demo only: unique task ids across demo restarts, scoreboard labels. It does not touch the benchmark path.
- Full check: 79 tests, typecheck, em-dash check and secret scan pass. A fresh clone runs `pnpm install && pnpm check`, and the demo, replay and verify-log all work from it.

## Needs you
- **Claude runs** need `ANTHROPIC_API_KEY` in `.env` (gitignored). Then run `pnpm redteam --model claude-sonnet-5-5 --runs 5` and `pnpm report`.
- **Anchor the head hash** before publishing: post the final guard DID and head hash (in `results/RESULTS.md`) somewhere outside the repo, for example in the LinkedIn post. Without that, `--expect-head` has nothing independent to check against.
- **Publishing** is yours: add the repo link to LINKEDIN.md, then push when ready. Nothing has been pushed.
