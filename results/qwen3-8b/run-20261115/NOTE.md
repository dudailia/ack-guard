# Pre-fix run (superseded)

This 3-run benchmark was recorded at commit 21d7f72, before the fixes from two
independent code reviews (parallel-payment race, log truncation and rollback,
signer pinning, per-agent daily cap, URL canonicalization, and others).

It is kept for the record and is not used in the README, the dashboard's
default view, the memo or the LinkedIn draft. The final benchmark replaces it.

Its headline numbers, for reference only: attacks moved unintended money in
46/105 naive runs and 1/105 guarded runs (DC-05, a designed gap probe); benign
tasks completed 24/24 for both agents.

`scripts/check-concurrent-payments.ts` on this log: 6 guarded episodes issued
parallel pay calls (all benign B-04/B-05); every decision is identical when
re-evaluated one payment at a time, so the race did not change any outcome.
