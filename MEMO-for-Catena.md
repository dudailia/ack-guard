# ACK Guard: the controls a trust bank needs before an agent can spend, built on ACK

*Ilia Duda, built with Claude Code. Independent project, not affiliated with or endorsed by Catena Labs. Code: github.com/dudailia/ack-guard. Live demo: dudailia.github.io/ack-guard.*

**What a trust bank has to be able to say about an agent's payment, and where ACK Guard provides it.**

| The bank needs | ACK Guard provides | Built on |
|---|---|---|
| A mandate the customer can read and the bank can enforce | `policy.yaml`: merchants, prices, limits and rules, each in plain English, rendered on a Policy page; a deterministic engine checks every payment against it | ACK-Pay signed payment requests |
| Change control on that mandate | A policy diff that replays the signed history under a proposed change ("38 past payments would now need a human") before the owner signs the approval; approvals go on a signed policy log, and the live guard runs the reviewed repository policy or the last change the owner approved | owner-signed JWT |
| Delegated authority with limits | Delegation chains owner -> agent -> sub-agent; each link has a budget, capabilities and an expiry; a child can never exceed its parent's remaining budget or capabilities, even when they pay concurrently | ACK-ID ControllerCredentials, verified link by link |
| Payee verification and counterparty onboarding | Merchant allowlist by DID, registered payout account, registered prices | ACK-ID merchant DIDs |
| A system of record | A hash-chained log signed by the guard; replay rebuilds any decision | did:key signatures |
| Dispute and chargeback evidence | `pnpm dispute <payment>`: a signed JSON pack and a one-page PDF (task, chain, policy version and rule, agent steps, receipt, verification) that the other side checks from the file alone | ACK PaymentReceiptCredential |

**Why it matters.** An agent with a wallet reads untrusted text, and any of it can say "pay this". Catena's own payments demo shows a "policy before signing" step and notes that a per-transaction cap is defeated by splitting, so a production policy needs cumulative budgets. ACK Guard builds that next step, decides only on facts ACK makes verifiable or the owner sets, and measures the effect.

**What the measurements show** (model: qwen3:8b running locally via Ollama, thinking off; ledger ground truth; every row re-derived from the signed log):
- **Main suite, 35 attacks and 10 benign tasks, 5 runs each.** Attacks reached their goal in 82/175 runs (46.9%) without the guard ($65.20 to attacker accounts) and 0/175 with it ($0.00; 95% interval 0.0% to 2.1%). The first version failed 2/175 on a URL-variant re-purchase; I fixed the rule, re-ran those scenarios and kept the old result in the report.
- **Delegation suite, 5 sub-agent escalation attacks and 2 benign hand-offs, 5 runs each.** The sub-agent exceeded its delegation in 9/25 runs without the guard and 0/25 with it (95% interval 0.0% to 13.3%); benign hand-offs completed 10/10 in both modes. Inside its delegation the sub-agent still bought forecasts it did not need ($2.00 in 8 runs).
- **Wrong item, right price (5 attacks, 5 runs each).** Injections steered the agent to another city or language at the real merchant and price: 25/25 got through the guard. I added `ITEM_BINDING` (the task names the item, e.g. city=Boston; the guard checks the paid URL): now 0/25, $0.00 wasted (was $7.50), but the small model then stopped instead of buying the right item. Benign tasks re-run with it: 40/50 and 10/10, unchanged.
- **Cost.** Benign tasks completed 50/50 without the guard and 40/50 with it: the other 10 cost over $1.00 and waited for a human by design (the benchmark's approver declines). After a block, the small model often stops instead of finishing the legitimate part.

**What it does not show.**
- One small local model and my own attacks; attack types it ignored (and forged credentials, parallel payments) rest on deterministic tests.
- Item binding checks only what the task states: an injection that changes the task itself, or an item the task leaves unspecified, still gets through.
- An in-memory ledger, not real rails. All keys sit on one machine. Delegation links expire but cannot be revoked early.
- The policy diff re-decides recorded payments but cannot replay how the agent would have continued. Deleting or rolling back the policy log falls back to an older policy unless its head is anchored outside the machine.
- A dispute pack proves what the guard signed, not that the log holds nothing else; that still needs the log head published outside the system.

**What I would build next.**
1. Revocation for delegation links (ACK status lists) and short-lived grants in the spirit of ACK v2.
2. External anchoring of the log head and merchant co-signed receipts, so evidence also proves completeness.
3. A run of all three suites on a frontier model is planned; then testnet rails.
