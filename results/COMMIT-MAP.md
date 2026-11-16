# Commit map

Before the repository was first published, its history was rewritten once to change the commit author and committer email to a GitHub no-reply address. Nothing else changed: every commit has the same file tree, message and dates as before, so each one has a new hash.

The recorded results, their signed audit logs and the docs cite the original hashes (for example "code at commit `5885950`"); those values are inside signed logs and are left as recorded. Use this table to find the published commit. The tree hash is the commit's content and is identical before and after, so `git rev-parse <new>^{tree}` reproduces the tree column.

| Original commit | Published commit | Tree (content, unchanged) | Subject |
|---|---|---|---|
| `24c0b33` | `a9f31b5` | `d8382e7cc520` | M0: scaffold project, pin agentcommercekit 0.11.0, ACK API spike |
| `ec692e3` | `0ad2f99` | `7ba20dba5922` | M1: ACK-ID identities, sandbox ledger, ACK-Pay receipt service, five merchants |
| `8f65215` | `479a9ec` | `2f33022c6603` | M2: deterministic policy engine with 12 ordered rules and tests |
| `ea19ca2` | `8e6f9b9` | `6879604d3cf6` | M3: hash-chained signed audit log, signed head, replay and verify-log CLIs, tamper tests |
| `21d7f72` | `8c27c4f` | `b188fd8afdea` | M4: model provider, naive and guarded agents, 35 attacks in 7 categories, 8 benign tasks, runner and scoring |
| `618a965` | `470cc81` | `0886afafb10a` | M4: runner tests with deterministic scripted model, em-dash and secret checks |
| `995d164` | `8b1db25` | `d7ca250bee8e` | M6: local dashboard with scoreboard, live timeline, replay, tamper demo and human approvals; one-command demo |
| `d559cd3` | `6f70f74` | `2576d6d0b29a` | M7: README, WALKTHROUGH, license and notice, generated results table script |
| `0469987` | `671b9b3` | `38a37fc783b4` | Update status; clarify replay heading |
| `5696e20` | `13f323e` | `20f5f74631f6` | Fix review findings: serialize payments, require head marker, pin audit signer, harden dashboard API, log settlement failures, safe canonical JSON, unique retry episode ids |
| `d60401b` | `10089a3` | `434c7f015edc` | Dashboard: skip plain files in results/; add concurrent-payment audit script |
| `6fcbdd1` | `cee2529` | `5e76853d5d0a` | Property-based tests (fast-check): policy invariants, approval cannot override deny, cumulative budget and daily cap under any order and concurrency, audit verifier fuzzing |
| `4a4c8f6` | `06e358f` | `6df091183e67` | Dashboard: one-click guided demo (legit payment, injected attack blocked with rule, tamper detected), plain-language labels, fresh log per demo session, superseded runs labelled |
| `6bae46f` | `11794e0` | `9a7ba9999ad9` | Fix second review: verified log reopening, external head anchor, run nonce, line-based replay integrity, per-agent daily cap across episodes, canonical URLs for duplicates, per-payment identity check, same-commit resume, above-threshold benign tasks |
| `df9e295` | `399a003` | `225669e533fe` | Demo: one persisted spend store per agent across live episodes |
| `6e7c202` | `8efd3b9` | `2b9649cb2349` | Add video recorder (Playwright + ffmpeg) and interview practice quiz |
| `2320c7e` | `f99807d` | `89be5b9358c8` | Docs: restructure README (guided demo, what the guard can't catch), update WALKTHROUGH for spend store, log reopening, anchors, canonical URLs and property tests |
| `c71bb18` | `414efe1` | `f2263facad0d` | Update status |
| `9272e8d` | `f45daed` | `5fb1ba62a50d` | Record pre-fix 3-run qwen3:8b benchmark, marked superseded |
| `5885950` | `8c7b9b9` | `83690b4e0274` | Fix third review: port/scheme duplicate bypass, emptied-log restart, numbers re-derived from the signed log, approvals outside the payment lock, per-episode task ids in the demo, receipts bound to the quoted resource, splitting attacks that exercise the cumulative caps, label and claim fixes |
| `412b926` | `9d7fa69` | `5a80a1899f27` | Quiz: how the numbers are backed by the signed log; review history |
| `0656773` | `a19c615` | `2ea5f6717d7d` | Update status |
| `2fda3cd` | `72eafcc` | `29d24f5af996` | Final benchmark: qwen3:8b, 5 runs, 450 episodes at 5885950, verified against the signed log |
| `6ab1936` | `aa9f82e` | `b028f5781768` | Docs from the final run; memo and LinkedIn draft; scripted coverage test for attacks qwen3 ignored |
| `9d4a6cd` | `da4e8b6` | `2e3f1c1f3cc9` | Demo media from qwen3; unique task ids across demo restarts (regression test); scoreboard labels |
| `a05b269` | `7bed03f` | `78d0e040a402` | STATUS: final numbers and what needs the owner |
| `6b11679` | `d9a8c04` | `d5b48d73d735` | Final review fixes with regression tests |
| `2c694eb` | `3fe99c0` | `6db781072172` | STATUS: final review and checks |
| `8387854` | `e007cd6` | `ea5959d38887` | STATUS wording |
| `0e0a6d7` | `b371bfd` | `930b304421bc` | Duplicate detection keys on merchant, capability and task; canonical URLs; partial re-runs in the report; Claude settings |
| `ae358ae` | `8c95155` | `12b46dc9475e` | Static guided demo for GitHub Pages |
| `ee8431b` | `305d2f7` | `e6ed4cf984ff` | Re-run of the duplicate-charge category and SE-04 after the duplicate rule change; docs and media from the combined results |
| `6f40111` | `26d66a3` | `9cdbf3b24d6d` | STATUS: DC-05 fix, re-run, static demo; Claude run awaiting cost approval |
| `1da966d` | `1dec1af` | `a5a59a02f373` | Readable policy: policy.yaml, a plain-language Policy page, policy diff, and owner-signed policy approvals |
| `869174b` | `d0bdbac` | `4e1e999b8245` | Delegation chains: owner -> agent -> sub-agent on ACK-ID, with budgets and capabilities per link |
| `8ba9a86` | `db6df0a` | `cc35fae04645` | Log the delegation chain JWTs with each payment attempt, so a third party can re-verify it from the log |
| `8a48807` | `11ff338` | `9ddce8871bb6` | Dispute evidence packs: pnpm dispute <payment-id> writes a signed JSON bundle and a one-page PDF; pnpm dispute-verify checks it from the file alone |
| `7e3c240` | `1a690ab` | `70a2a8fa6c99` | Dashboard: delegation chain in the replay, dispute pack downloads, delegation scenarios in the live runner |
| `1c5acd5` | `a5231a5` | `127d8d2d3a18` | Delegation suite on qwen3 (5 runs, 70 episodes), example dispute packs, docs for policy, delegation and disputes |
| `609134d` | `079ae37` | `6cd7df81a90e` | Demo video with the Policy page and diff (81s), policy screenshot, smaller GIF, static site rebuilt |
| `c6e7cfa` | `ac9e206` | `7b357dc8f659` | Review fixes for the new features, each with a regression test |
| `bbb9e4a` | `10e823f` | `320d8a3c1793` | Second review fixes: dispute packs bind every stated field, policy identities and approvals tightened |
| `b6892cc` | `19b630d` | `aaebc3926589` | STATUS: readable policy, delegation chains, dispute packs, review fixes and final checks |
| `5ea7a7f` | `28a8904` | `88f180cfa0cd` | README tour for the Catena team, memo PDF, results tables name the local model, links for publishing |
| `8ff1c39` | `4005324` | `30c3dda2b662` | Static site: both suites, the human-approval note, the local model, repo link |
