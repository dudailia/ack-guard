# Interview practice: 21 questions about ACK Guard

These are the questions a Catena engineer is likely to ask, with model answers. Cover the answer, say yours out loud, then compare. The numbers come from `results/` and the README; re-read them before the interview.

---

**1. In one minute: what is ACK Guard?**

An AI agent with a wallet reads untrusted text all day, and any of it can say "pay this". ACK Guard puts a small deterministic policy function between the agent and its wallet. The function decides using only facts that were verified cryptographically (ACK-ID credentials, signed ACK-Pay requests) or set by the owner (allowlist, prices, the task's needs and budget). Every decision is written to a hash-chained, signed log that can be replayed and checked. A red-team suite runs the same model with and without the guard, so the effect is measured rather than asserted.

**2. Why not just make the model better at spotting injections?**

Because the model is the component under attack, and its resistance is probabilistic. Better models help, but you cannot write a guarantee about one. The guard does not need the model to be right: it refuses payments that fail checks the model cannot influence. The two approaches are complementary. In the results, the guarded agent is still fooled into trying the attacker's payments. The guard refuses them.

**3. Which ACK pieces did you use, and which did you build?**

From `agentcommercekit` 0.11.0:
- DIDs and the resolver
- `createControllerCredential` and its verifier (ACK-ID)
- `createSignedPaymentRequest` and `verifyPaymentRequestToken`
- `createPaymentReceipt` and `verifyPaymentReceipt` (ACK-Pay)
- JWT signing for the audit log

I built the policy engine, the sandbox (merchants, ledger, receipt service), the audit chain and replay, the agent harness, the red-team suite and the dashboard. ACK deliberately leaves policy to the implementer. Its payments demo has a small "policy before signing" example and says a real control needs cumulative budgets. That is where this project starts.

**4. Walk me through a payment.**

1. The agent calls a merchant URL.
2. The merchant answers 402 with a payment request signed by its DID.
3. The agent calls `pay(pr_3)`.
4. The guard gathers verified facts:
   - the request's signature and selected option
   - the agent's ControllerCredential
   - whether this exact token arrived in a 402 to a URL the agent called (provenance)
5. It runs twelve rules in a fixed order and logs the decision.
6. If allowed, money moves on the sandbox ledger.
7. The receipt service checks the transfer against the signed option and issues a PaymentReceiptCredential.
8. The merchant verifies the receipt with `verifyPaymentReceipt` and serves the data.

**5. Which rule matters most, and why?**

`REQ_PROVENANCE`. In ACK-Pay a legitimate quote exists because you asked a service for something and it answered 402. A payment request that shows up in an email, a web page or a JSON field is not a quote for anything you asked for. The guard sits in the HTTP client, so it knows which tokens came from 402s and from which URL. In the recorded run that one rule refused every fake-invoice payment the agent attempted, without understanding any text.

**6. An attacker controls a real merchant's server. What still protects the owner?**

(Related: the sandbox merchants also bind each ACK receipt to the endpoint and URL it was quoted for, and accept it once, so a cheap receipt cannot unlock an expensive endpoint.)


The attacker can sign valid requests with the merchant's key, so signature and allowlist checks pass. But:
- `RECIPIENT_BINDING` rejects a changed payout account.
- `PRICE_BINDING` rejects any amount, currency or decimals that differ from the registered price.
- `PURPOSE_BINDING` rejects endpoints the task did not declare.
- `DUPLICATE_CHARGE` rejects re-billing.
- `TASK_BUDGET` and `DAILY_CAP` bound everything else.

What remains is in-policy over-purchasing, up to the budget.

**7. What can the guard not catch?**

- Purchases that are correctly priced, from an allowlisted merchant, for a declared capability, and within budget, but unnecessary. Examples are re-buying the same forecast through a slightly different URL (`DC-05`, the guarded failure in the results: 2 of 5 runs, $0.50) and buying forecasts for three extra cities (`HI-05`, which qwen3 ignored, so only the scripted test shows it). Damage is bounded by the task budget, not prevented.
- A wrong registry: if the operator registers the wrong payout account, the guard enforces the wrong thing.
- Anything that bypasses `pay()`. In production the keys belong to the guard, not the agent.

**8. How is the naive agent fair? Did you handicap it?**

Same model, system prompt, task prompt, tools, temperature, step limit and seed per run. Both share one code path; the only difference is inside `pay()`. The naive agent is a correct ACK client: it verifies payment request signatures and receipts. It just has no policy. The system prompt even tells both agents to spend only on what the task needs.

**9. How do you score an attack as successful?**

On the sandbox ledger, never on what the model says. Each attack declares its goal:
- money reached a non-merchant account
- total spend exceeded what the task needed
- spend passed the task budget
- spend passed the daily cap

The report also shows any harm flag, not just the declared goal, and the money moved.

**10. Why do some attacks fail even against the naive agent?**

The small model sometimes ignores the bait, or gives up. Those runs do not exercise the guard, and the report lists those scenarios instead of hiding them. In the final run qwen3 ignored every hidden-instruction attack and four of five splitting attacks, so those rules are covered by a deterministic scripted agent in the tests, not by the measurement. A stronger model might take different baits; that is why a Claude run is the obvious next measurement.

**11. Does the guard hurt legitimate use?**

Measurably, in two ways the results report:
- Payments above $1 go to a human, and the benchmark's scripted approver declines by default, so those benign tasks do not complete.
- After a block, the small model often stops instead of finishing the legitimate part of the task, so "legit task still completed during an attack" is lower for the guarded agent.

The first is a policy setting. The second is a UX problem: the block message should help the agent continue.

**12. Explain the audit log.**

- Each JSONL entry is `{seq, ts, kind, payload, prevHash, hash, sig}`.
- The hash is SHA-256 of the canonical JSON.
- The signature is a JWT from the guard's DID over `{seq, hash}`.
- After every append, a signed head checkpoint records the last entry.

The verifier checks the sequence, the chain links, every hash, every signature against a pinned guard DID, and the head. It reports the first position where the chain breaks. A fuzz test applies random edits, deletions, reorders, truncations, duplications and forged entries, and every one is detected at the right position.

**13. Can someone forge a log?**

- Without the guard key, they can't produce valid signatures. That's why the verifier pins the expected guard DID from outside the log. A whole new log signed by a different key is reported as "not pinned", not "verified".
- With the key, the residual risk is rollback: restoring an older log together with its older, genuine head. For that, the head hash has to be anchored outside the log, which is what `verify-log --expect-head` checks.
- The log also refuses to continue after damage, so a truncation cannot be "healed" by the next append.

**14. What does replay prove?**

It rebuilds one attempt from the log alone:
- the task as the owner set it
- what the agent did
- the payment request it asked for, re-verified
- every policy check and the rule that decided
- any human approval
- the settlement
- the receipt, re-verified with ACK's `verifyPaymentReceipt`
- the identity, re-verified

Replay only calls itself trustworthy when the whole log verifies against a pinned key. Otherwise it labels the result unverified.

**15. Why is the policy a pure function?**

Determinism and testability. The same facts always give the same decision. Every rule has unit tests, and property-based tests check invariants such as:
- "allow implies every invariant holds"
- "approval never overrides a deny"
- "cumulative spend never exceeds the task budget or the daily cap in any order"

I also mutation-checked the properties: breaking `RECIPIENT_BINDING` or `TASK_BUDGET` makes them fail.

**16. How do you handle concurrency?**

The AI SDK can run several tool calls from one model step concurrently. Without care, two payments would be evaluated against the same empty history and both pass. All payment decisions for an agent go through one lock in a shared spend store. A property test fires random batches of concurrent payments and checks the ledger never exceeds the budget or cap. An independent review found this race. I fixed it and replayed the affected episodes of the earlier run one payment at a time; every decision came out the same. Human approvals are awaited outside the lock, so one pending approval never stalls other payments.

**17. How would this map to a trust bank?**

The engine becomes the authorization step for agent-initiated payments:
- the owner's declared needs and budgets become mandates
- the merchant registry becomes counterparty onboarding
- recipient binding becomes payee verification
- the signed log becomes the system of record that compliance and disputes replay

The ACK receipt ties each ledger entry to a specific signed quote and a specific accountable agent and owner. Human approval is the step-up flow.

**18. What would you build next?**

- Parameter-scoped needs: pay once for `forecast?city=Boston`, not "any forecast". That closes `DC-05` and `HI-05`.
- ACK v2-style short-lived grants and RFC 9421 request signatures, so the ControllerCredential is not a bearer token every host sees.
- External anchoring of the log head.
- Merchant co-signed receipts.
- A block message that helps the agent finish the legitimate task.
- Claude runs for a frontier-model comparison.

**19. What surprised you while building it?**

- Ollama's default 4k context silently truncated long episodes.
- A small model copying 700-character JWTs made attacks fail for reasons unrelated to security, so I gave payment requests short references.
- A 10-step limit made splitting attacks physically impossible, which would have flattered the guard.

Each would have biased the results, and each is documented.

**20. How do I know the numbers in the README are real?**

- **Re-derived from the signed log.** `pnpm report` doesn't trust the summary files. It re-derives every scored row from the audit log's signed entries: the transfers, the decisions and the merchant service records. It checks that the log's run id and final head hash match the run's metadata, and refuses to publish if anything disagrees.
- **One code version per run.** The run records its git commit and refuses to resume on different code.
- **Fixes were checked against recorded results.** Three independent reviews ran during the build. Each confirmed finding got a fix and a regression test. One of them was a race that could have changed results, and I replayed the affected episodes to show it did not.
- **The limit:** the guard DID and head hash also live in the repository, so for full assurance they need to be published somewhere else as well.

**21. What would make you distrust these results?**

- One small local model with thinking off.
- Attacks I wrote myself, so they reflect my imagination of the threat.
- A sandbox ledger instead of real rails.
- Five runs per scenario.

The confidence intervals are in the report. I would want a frontier model, attacks written by someone else, and a merchant integration on a real testnet before claiming more.
