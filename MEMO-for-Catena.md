# ACK Guard: a policy and audit layer for ACK-Pay, measured

*Ilia Duda, built with Claude Code. Independent project, not affiliated with or endorsed by Catena Labs.*

**The question.** If an AI agent holds a wallet and reads untrusted text, can a payment rule be enforced that the text cannot argue with? Catena's ACK payments demo already points at the answer and its next step. It includes a "policy before signing" example, and its README notes that a per-transaction cap is trivially defeated by splitting, so a production policy needs cumulative budgets. ACK Guard builds that next step and measures it.

**What it shows.**
- **Attacks.** 35 payment attacks in 7 categories plus 10 benign tasks, run 5 times each against the same local model (qwen3:8b) with and without the guard: 450 episodes, judged on a sandbox ledger.
- **Without the guard,** attacks moved unintended money in 82/175 runs (46.9%), sending $65.20 to attacker accounts.
- **With the guard,** 0/175 (95% interval 0% to 2.1%) and $0.00. The first version failed 2/175: re-buying the same forecast under a new query string (`DC-05`) passed a URL-based duplicate rule. I replaced it with one that counts purchases per merchant, capability and task, re-ran the affected scenarios, and kept the old result in the report. The model still tried payments the guard refused in 82 of 175 guarded attack runs, most of them injected requests.
- **Cost.** No benign payment was blocked by a deny rule, but the two benign tasks above the $1 approval threshold waited for a human and, with the benchmark's deny-by-default approver, did not complete (benign completion 40/50 guarded, 50/50 naive). During attacks the legitimate task still completed in 87/175 guarded runs against 109/175 naive, because after a block the small model often stops.
- **Evidence.** Every decision names the rule that fired and lands in a hash-chained log signed by the guard's DID. Every settlement gets an ACK `PaymentReceiptCredential`, which the merchant verifies before serving. Replay rebuilds any payment or blocked attempt and re-verifies the ACK receipt and the ACK-ID credential. A fuzzer shows every random edit, deletion, reorder or truncation of the log is detected at the right entry.

**How it maps to ACK.** The guard decides only on facts ACK makes verifiable or the owner sets:
- the `ControllerCredential` chaining the agent to its owner (ACK-ID)
- the merchant DID's signature on the 402 `PaymentRequest`, and the fact that this exact request came back from a URL the agent called (ACK-Pay)
- operator configuration: the allowlist, payout accounts, prices, and the task's declared needs and budget

The single most effective rule is provenance. A legitimate quote is one you asked for, so a payment request found in an email or a web page is refused without parsing any text.

**How it maps to a trust bank.**

| ACK Guard | At a trust bank |
|---|---|
| Owner's declared needs and budgets | Mandates |
| Merchant registry | Counterparty onboarding |
| Recipient binding | Payee verification |
| Daily cap and task budget | Spend limits |
| Human approval | Step-up authorization |
| Signed log | System of record for compliance and disputes, tying each ledger entry to a signed quote, an accountable agent and its owner |

**What it does not show.**
- Results come from one small local model with thinking off, and attacks I wrote myself. That model ignored every hidden-instruction attack and four of five splitting attacks even without the guard, so those rules are covered by deterministic tests, not by the measurement.
- Settlement is an in-memory ledger.
- The guard limits how many of each capability a task buys, not which item: a steered purchase of the wrong item is bounded by the budget, not prevented.
- The ControllerCredential is a bearer token here.
- Log rollback is caught only with an externally anchored head hash.

**What I would build next.**
1. Needs scoped to parameters ("one forecast for Boston"), which closes the wrong-item gap.
2. ACK v2-style short-lived grants and RFC 9421 request signatures in place of the bearer credential.
3. Head anchoring and merchant co-signed receipts, so the log proves completeness as well as integrity.
4. A block response that helps the agent finish the legitimate task.
5. The same benchmark on a frontier model, and on real testnet rails.
