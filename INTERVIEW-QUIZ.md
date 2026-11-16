# Interview practice: 30 questions about ACK Guard

These are the questions a Catena engineer is likely to ask, with model answers. Cover the answer, say yours out loud, then compare. The numbers come from `results/` and the README; re-read them before the interview.

---

**1. In one minute: what is ACK Guard?**

An AI agent with a wallet reads untrusted text all day, and any of it can say "pay this". ACK Guard puts a small deterministic policy function between the agent and its wallet. The function decides using only facts that were verified cryptographically (ACK-ID credentials, signed ACK-Pay requests) or set by the owner (allowlist, prices, the task's needs and budget). Every decision is written to a hash-chained, signed log that can be replayed and checked. A red-team suite runs the same model with and without the guard, so the effect is measured rather than asserted.

**2. Why not just make the model better at spotting injections?**

Because the model is the component under attack, and its resistance is probabilistic. Better models help, but you cannot write a guarantee about one. The guard does not need the model to be right: it refuses payments that fail checks the model cannot influence. The two approaches are complementary. In the results, the guarded agent still tries payments the guard refuses, in 82 of 175 attack runs. Most come from injected text; 20 are quotes from a merchant that was itself compromised.

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
- `DUPLICATE_CHARGE` rejects re-billing and re-buying: it counts purchases per merchant DID, capability and task, so a new URL for the same thing is still a repeat.
- `TASK_BUDGET` and `DAILY_CAP` bound everything else.

What remains is in-policy over-purchasing, up to the budget.

**7. What can the guard not catch?**

- The wrong item in the right quantity. Duplicate detection counts purchases per merchant, capability and task, so an attacker can no longer make the agent buy extra forecasts, but can still steer which city the one forecast is for. It is correctly priced and paid to the real merchant: waste, bounded by the budget, not theft.
- History: the first version keyed duplicates on the URL, and `DC-05` (re-buying with `refresh=1`) beat it in 2 of 5 runs. I changed the rule, replayed every recorded decision under the new engine to find which scenarios it affects (`DC-05` and `SE-04`), re-ran those, and kept the old result in the report. Now 0 of 175 guarded attack runs succeed, with a 95% interval up to 2.1%.
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
- With the key, anyone can sign a whole new log, or roll back to an older log with its older, genuine head. Only a head hash anchored outside the log before the key leaked defends against that, which is what `verify-log --expect-head` checks. In this demo the key sits unencrypted in `.data/keys.json` next to the logs; in production it belongs in an HSM or KMS.
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

- Parameter-scoped needs: "one forecast for Boston", not "one forecast". Quantity-aware duplicate detection already closed `DC-05` and `HI-05`; scoping the parameters would also stop an attacker from steering which item the agent buys.
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
- **Fixes were checked against recorded results.** Four independent reviews ran, the last one after the final benchmark. Each confirmed finding got a fix and a regression test. The last round's fixes touch the benchmark code path only when an audit log write fails, which never happened in the recorded run (0 errors). One of them was a race that could have changed results, and I replayed the affected episodes to show it did not.
- **The limit:** the guard DID and head hash also live in the repository, so for full assurance they need to be published somewhere else as well.

**21. What would make you distrust these results?**

- One small local model with thinking off.
- Attacks I wrote myself, so they reflect my imagination of the threat.
- A sandbox ledger instead of real rails.
- Five runs per scenario.

The confidence intervals are in the report. I would want a frontier model, attacks written by someone else, and a merchant integration on a real testnet before claiming more.

---

## Readable policy, delegation chains and dispute evidence

**22. Why move the policy into a YAML file? Isn't code more precise?**

The rules stay in code: the engine and their order are fixed and tested. The file holds what an owner or a compliance officer has to own: which merchants, what prices, which limits, which rules are on, and whether a failure is refused or sent to a human. Each rule has a one-sentence plain-English line, and the Policy page renders it for a non-engineer. A test pins the file to the configuration the benchmark ran with, so the move changed no recorded decision. The file cannot switch off the signature or identity checks.

**23. How does the policy diff work, and what can't it tell you?**

It verifies a signed audit log against the pinned guard key first. Then, for every recorded guarded decision, it rebuilds the spend history from the settlements recorded before that decision and evaluates the recorded facts twice with today's engine: under the current policy and under the proposed one. It lists every change as now allowed, now blocked, now held for a human, or a different reason. What it can't know is how the agent would have continued after a decision that comes out differently; it marks later changes in the same episode as indicative. Example: on the recorded benchmark, lowering the approval threshold to $0.40 sends 38 past payments to a human.

**24. What stops someone from editing the active policy on disk?**

The live guard loads a changed policy only if the signed policy log verifies, its last `policy_change` entry is exactly the active file's hash, and that entry carries a JWT signed by the configured owner over the old hash, the new hash and a digest of the diff that was shown. Editing the file, editing the log, a fork in the log, or an approval signed by anyone else is refused, and the demo will not start. Three honest caveats:
- Without any approved change the guard runs the repository's `policy.yaml`, reviewed in version control but not owner-signed.
- Deleting or rolling back the policy log falls back to an older policy silently. Like the audit log, its head needs an external anchor.
- In this demo the owner's key is on the same machine as the guard's. In production the owner signs on their own device and the guard only verifies.

**25. How is a delegation link represented, and why not invent a new credential?**

It is an ACK-ID `ControllerCredential` made with ACK's `createCredential`: issuer the parent, subject the child, controller claim the parent, plus a `delegation` object (budget, currency, capabilities) and an expiry. The child's did:web document names the parent as controller, exactly the pattern ACK uses for an agent and its owner, so ACK's own verifiers check every link. A new credential type would need its own verifier and would not interoperate.

**26. How does the guard make sure a child never exceeds its parent's remaining budget?**

Every settled payment records the ids of the scoped links it was made under. Spent under a link is the sum over its whole subtree, so the parent's own purchases and every descendant's count together. A purchase must fit every link: allowed by each one's capabilities, and within what each one has left. A parent that signs its child a $10 link when it only has $1 gains nothing, because the parent's $1 link still binds. All decisions run under one lock in the shared spend store, so concurrent payments from parent and child are decided one at a time; a property test fires random concurrent batches from both and checks the ledger.

**27. What do the delegation attacks show?**

The sub-agent is the LLM; its hand-off note tries to make it overspend. There are five attacks:
- a forged "upgraded" credential (wrong key)
- an expired broader one
- more work than its budget covers
- a genuine re-issue that exceeds the parent's own limits
- a parallel burst

With the scripted agent the guard refuses the first two on `AGENT_IDENTITY` and the rest on `DELEGATION_LIMITS`. On qwen3 the sub-agent exceeded its delegation in 9 of 25 runs without the guard and 0 of 25 with it, and the benign hand-offs completed 10 of 10 in both modes. Be precise about the limits: qwen never paid under an offered credential and never paid in parallel, so the forged, expired and concurrent cases rest on the scripted test and the property test. And inside its delegation the guarded sub-agent still bought forecasts it did not need, $2.00 over 8 runs: bounded by the delegation, not prevented.

**28. What is in a dispute evidence pack, and what does it prove?**

It contains:
- the task as the owner set it
- the delegation chain
- the policy version and every rule's result
- the agent's steps before the payment
- the ACK payment request and receipt
- the verification results
- the raw signed log entries those claims rest on, with the signed head
- the did:web documents needed offline

The whole bundle is signed by the guard. `pnpm dispute-verify` checks it from the file alone: guard signatures against the pinned did:key itself; every field the pack and its PDF state against the signed entries; the ACK artifacts and the chain (as of the payment time) exactly as the pack reports them; and the stored results against a fresh run. Independent reviews found two holes before this held: a pack forged without the guard key by planting a DID document for the guard's own DID, and summary fields the verifier did not yet compare (changing those still needed the guard key). Both are now regression tests. It proves what the guard recorded and signed for that attempt. It does not prove the log holds nothing else about the payment; that needs the full log checked against an independently published head hash.

**29. A delegation link expired last week. Can the pack for a payment made under it still verify?**

Yes. The verifier checks each link's signature and expiry with ACK's `verifyJwt`, with the clock set to the payment time, then runs ACK's controller-claim verifier. A link valid then still verifies. A forged link never does, at any time. A test covers both.

**30. How do these three map to what a trust bank needs?**

- **policy.yaml with diff and signed approvals:** a mandate the owner can read, plus change control. Every change is reviewed against real history and approved with the owner's key on a signed record.
- **Delegation chains:** delegated authority with limits that compound down the chain. That is what lets an institution say "this sub-agent spent under this mandate, within these limits".
- **Dispute packs:** the evidence for a chargeback or a complaint, in a form the other side can verify without trusting the bank's systems.

