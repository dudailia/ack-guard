# ACK Guard: the controls a trust bank needs before an agent can spend, built on ACK

*Ilia Duda, built with Claude Code. Independent project, not affiliated with or endorsed by Catena Labs.*

**What a trust bank has to be able to say about an agent's payment, and where ACK Guard provides it.**

| The bank needs | ACK Guard provides | Built on |
|---|---|---|
| A mandate the customer can read and the bank can enforce | `policy.yaml`: merchants, prices, limits and rules, each in plain English, rendered on a Policy page; a deterministic engine checks every payment against it | ACK-Pay signed payment requests |
| Change control on that mandate | A policy diff that replays the signed history under a proposed change ("38 past payments would now need a human") before the owner signs the approval; approvals go on a signed policy log, and the guard runs only the last approved policy | owner-signed JWT |
| Delegated authority with limits | Delegation chains owner -> agent -> sub-agent; each link has a budget, capabilities and an expiry; a child can never exceed its parent's remaining budget or capabilities, even when they pay concurrently | ACK-ID ControllerCredentials, verified link by link |
| Payee verification and counterparty onboarding | Merchant allowlist by DID, registered payout account, registered prices | ACK-ID merchant DIDs |
| A system of record | A hash-chained log signed by the guard; replay rebuilds any decision | did:key signatures |
| Dispute and chargeback evidence | `pnpm dispute <payment>`: a signed JSON pack and a one-page PDF (task, chain, policy version and rule, agent steps, receipt, verification) that the other side checks from the file alone | ACK PaymentReceiptCredential |

**Why it matters.** An agent with a wallet reads untrusted text, and any of it can say "pay this". Catena's own payments demo shows a "policy before signing" step and notes that a per-transaction cap is defeated by splitting, so a production policy needs cumulative budgets. ACK Guard builds that next step, decides only on facts ACK makes verifiable or the owner sets, and measures the effect.

**What the measurements show** (qwen3:8b, local, thinking off; ledger ground truth; every row re-derived from the signed log):
- **Main suite, 35 attacks and 10 benign tasks, 5 runs each.** Attacks reached their goal in 82/175 runs without the guard ($65.20 to attacker accounts) and 0/175 with it (95% interval 0% to 2.1%). The first version failed 2/175 on a URL-variant re-purchase; I changed the duplicate rule, re-ran the affected scenarios and kept the old result in the report. In 82 of those 175 guarded runs the model still tried a payment the guard refused: the guard, not the model, stopped them.
- **Delegation suite, 5 sub-agent escalation attacks and 2 benign hand-offs, 5 runs each.** The sub-agent exceeded its delegation in 9/25 runs without the guard and 0/25 with it; benign hand-offs completed 10/10 in both modes. The model never presented the forged or expired credentials and never paid in parallel, so those paths rest on deterministic tests; within its delegation, the guarded sub-agent still bought forecasts it did not need ($2.00 in 8 runs).
- **Cost.** Payments above $1 wait for a human (2 benign tasks did not complete under the benchmark's deny-by-default approver), and after a block the small model often stops instead of finishing the legitimate part.

**What it does not show.**
- One small local model and attacks I wrote myself; some attack types the model ignored even without the guard, so those rules rest on deterministic tests, not on the measurement.
- An in-memory ledger, not real rails.
- The owner's, agent's and guard's keys sit on one machine; in production each signs on its own device.
- Delegation links expire but cannot be revoked early.
- The policy diff re-decides recorded payments but cannot replay how the agent would have continued.
- A dispute pack proves what the guard signed, not that the log holds nothing else; that still needs the log head published outside the system.

**What I would build next.**
1. Revocation for delegation links (ACK status lists) and short-lived grants in the spirit of ACK v2.
2. Needs scoped to parameters ("one forecast for Boston"), so an attacker cannot steer which item is bought.
3. External anchoring of the log head and merchant co-signed receipts, so evidence also proves completeness.
4. The same suites on a frontier model and on testnet rails.
