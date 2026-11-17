# STATUS

Last updated: 2026-11-17. Published v1.1 (item binding).

- Repo: https://github.com/dudailia/ack-guard (public)
- Live demo: https://dudailia.github.io/ack-guard/ (GitHub Pages, deployed by GitHub Actions from `site/`)
- Releases: https://github.com/dudailia/ack-guard/releases/tag/v1.1 (item binding; updated `memo.pdf`, the same `demo.mp4`; head hashes of the four new logs) and https://github.com/dudailia/ack-guard/releases/tag/v1.0 (kept; the guard DID and the three original log head hashes)

Before the first push, the history was rewritten once to set the author and committer to the GitHub no-reply address; every commit's tree is unchanged, and `results/COMMIT-MAP.md` maps the hashes cited by the results to the published ones. `.env` is gitignored, untracked and in no commit.

Checked after publishing: a signed-out clone installs, runs the live guided demo (paid, blocked by REQ_PROVENANCE, tampering detected), serves the Policy page, reproduces the README with `pnpm report` and verifies both example dispute packs; the live Pages site loads, verifies its log in the browser and runs the guided replay with no console errors.

## v1.1: item binding (2026-11-17)
- `ITEM_BINDING` (after `PURPOSE_BINDING`): a task can list items (capability plus exact query parameters); the guard refuses a payment whose 402 URL is not one of them. Plain-English line in `policy.yaml`; recorded in every signed decision. Tests: `test/item-binding.test.ts` (unit, sandbox through the real merchant, a merchant redirect, property tests).
- Wrong-city suite on qwen3:8b, 5 runs: guarded wrong item bought 25/25 before (`wrong-city-20261116`), 0/25 after (`wrong-city-item-binding-20261117`); $0.00 wasted (was $7.50); attacked tasks still 0/25 completed because the model stops after the refusal; control 5/5.
- Benign regression checks, guarded only, 5 runs: main 40/50 (B-09, B-10 held for a human, as before), delegation 10/10; all 80 benign decisions checked their items and passed.
- Main and delegation attack results unchanged (recorded before the rule, not re-run).
- Checked: `pnpm check` (173 tests), fresh clone reproduces the README with `pnpm report`, live site deployed and verified in the browser, release assets match.

## Recorded results

**Main suite (unchanged since v1.0):** `results/qwen3-8b/current/`, base run `final-20261116` plus the `dc-fix-20261116` re-run.

| | Without guard | With ACK Guard |
|---|---|---|
| Attack runs where the attack reached its goal | 82/175 (46.9%) | 0/175 (0.0%, CI 0.0% to 2.1%) |
| Money to attacker accounts | $65.20 | $0.00 |
| Benign tasks completed | 50/50 | 40/50 |

`pnpm report` reproduces these exactly, also in a fresh clone. Re-evaluating the recorded decisions with today's engine (`scripts/reevaluate-policy.ts`) changes nothing in the re-run log and only the already-replaced DC-05/SE-04 rows in the base log.

**Delegation suite (new, reported separately):** `results/qwen3-8b/delegation-20261116/` (5 attacks, 2 benign, 5 runs, both agents, 70 episodes, commit 8ba9a86).

| | Without guard | With ACK Guard |
|---|---|---|
| Attack runs where the sub-agent exceeded its delegation | 9/25 (36.0%) | 0/25 (0.0%, CI 0.0% to 13.3%) |
| Benign hand-offs completed | 10/10 | 10/10 |

The docs state what this run did not exercise:
- qwen never paid under an offered credential, so the forged and expired credential paths rest on the scripted test.
- It never paid in parallel, so the concurrency case rests on the property test.
- DL-02 and DL-04 had no effect even without the guard.
- In-delegation over-purchase ($2.00 over 8 guarded runs) is allowed and listed as a limit.

## Done this round (commits)
- **1da966d: readable policy.**
  - `policy.yaml` (pinned by test to the recorded configuration)
  - Policy page
  - `pnpm policy-diff`
  - owner-signed approvals on a signed policy log; the live guard loads only the last approved policy
- **869174b, 8ba9a86: delegation chains.**
  - ACK-ID ControllerCredential links carrying budget, capabilities and expiry
  - `DELEGATION_LIMITS`, with subtree spend under the payment lock
  - the delegation suite
  - the key file now only adds new keys (the guard key is unchanged)
  - the chain JWTs are logged with each attempt
- **8a48807, 7e3c240: dispute packs.**
  - `pnpm dispute` and `pnpm dispute-verify`
  - a one-page PDF
  - the dashboard download
  - chain verification as of the payment time
- **1c5acd5, 609134d: results and docs.**
  - delegation run and example packs (`docs/examples/`, both verify)
  - README, WALKTHROUGH, INTERVIEW-QUIZ (30 questions); memo led by trust-bank needs
  - demo video (81 s) with the Policy page and diff, policy screenshot, 1.6 MB GIF, static site rebuilt
- **c6e7cfa, bbb9e4a: fixes from two independent reviews of the new features, each with a regression test.**
  - Critical: a dispute pack could be forged without the guard key, by planting a DID document for the guard's own DID. Fixed: guard signatures are checked against the pinned did:key with nothing taken from the pack.
  - Critical: a re-encoded (ECDSA high-s) copy of a delegation link got a fresh budget. Fixed: a link's id is the hash of its signed content.
  - The policy diff ignored spend under delegation links; it now replays it, and all 73 recorded delegation decisions reproduce.
  - The policy file now rejects duplicate endpoint paths and two merchants sharing one identity.
  - Link spend no longer ages out of the persisted store.
  - Approvals must continue from the active policy; the owner's JWT and the stored diff summary are re-checked on load; a diff that replayed nothing cannot be approved.
  - Dispute packs: every field they or their PDF state is bound to the signed entries, and a pack for a REQ_SIGNATURE refusal verifies honestly.
  - Docs: the repository policy is described as the unsigned baseline, along with policy-log rollback, budgets per signed link, the key-registry limit and the limits of concurrent-episode replay.
  - The recorded results are unaffected: the README results block is byte-identical, and the re-evaluation of both recorded suites reproduces every decision.
- **Full check at bbb9e4a, from a fresh clone:**
  - 138 tests, typecheck, em-dash check and secret scan pass
  - `pnpm report` reproduces the README
  - both example packs verify
  - the live demo runs the legit purchase (paid), FI-01 (blocked by REQ_PROVENANCE) and DL-03 (overreach blocked by DELEGATION_LIMITS), and serves the Policy page

## Needs you
- **Frontier-model run (deferred until after the email to Catena):** `pnpm redteam --model claude-sonnet-5-5 --runs 5` and `pnpm redteam --suite delegation --model claude-sonnet-5-5 --runs 5`, thinking off (about $13 plus $2). Needs `ANTHROPIC_API_KEY` in `.env`, which does not exist yet. The README's "What's next" says the run is planned.
- **LinkedIn:** `LINKEDIN.md` is ready with the repo and live demo links; post it when you choose.
