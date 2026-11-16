# ACK Guard walkthrough

This document explains every component, why it exists, and where to find it, in the order a payment travels. It ends with questions an interviewer is likely to ask and straight answers.

## 1. The problem in one paragraph

An LLM agent with a wallet reads untrusted text all day: web pages, emails, API responses. Any of that text can say "pay this". Prompt-injection defenses inside the model reduce how often the model is fooled, but they are probabilistic, and the model is the thing being attacked. ACK Guard takes the opposite approach: assume the model will sometimes be fooled, and make the payment decision somewhere the model cannot reach. That place is a small, deterministic function that checks facts which were verified cryptographically or set by the owner, never facts the model asserts.

## 2. What ACK provides, and what this project adds

ACK (Agent Commerce Kit, by Catena Labs, MIT) gives two protocols:

- **ACK-ID**: agents get DIDs, and an owner proves control with a W3C Verifiable Credential (`ControllerCredential`). A verifier can answer "who is accountable for this agent?" cryptographically.
- **ACK-Pay**: a seller answers an unpaid request with HTTP 402 and a signed `PaymentRequest` (a JWT listing payment options). After payment, a receipt service issues a signed `PaymentReceiptCredential` that the seller verifies.

ACK deliberately leaves *policy* to the implementer. Catena's payments demo contains a tiny "policy before signing" example (`demos/payments/src/payment-policy.ts`): a recipient allowlist and a per-transaction cap. Its README warns that a per-transaction cap is trivially defeated by splitting, and that real controls need cumulative budgets. ACK Guard is that policy layer, built out, plus the audit trail and the measurements.

ACK functions this project calls (all from `agentcommercekit@0.11.0`):

| ACK function | Where | Why |
|---|---|---|
| `generateKeypair`, `createDidKeyUri`, `createDidWebDocumentFromKeypair`, `createDidDocumentFromKeypair`, `getDidResolver` | `src/identity/identities.ts` | DIDs for every party |
| `createControllerCredential`, `signCredential` | `src/identity/identities.ts` | The owner vouches for the agent |
| `parseJwtCredential`, `verifyParsedCredential`, `getControllerClaimVerifier` | `src/identity/verify-identity.ts` | Verifying that vouching |
| `createSignedPaymentRequest` | `src/merchants/framework.ts` | Merchants' 402 responses |
| `verifyPaymentRequestToken` | `src/world.ts`, `src/receipts/receipt-service.ts` | Checking a request's signature before paying |
| `createPaymentReceipt`, `signCredential` | `src/receipts/receipt-service.ts` | Receipts |
| `verifyPaymentReceipt` | `src/receipts/receipt-service.ts` (`checkReceipt`) | Merchants, replay and tests verify receipts |
| `createJwt`, `verifyJwt` | `src/audit/chain.ts`, `src/audit/verify.ts` | Signing and verifying audit entries with the guard's DID |

## 3. Components, in the order a payment travels

### 3.1 Identities (`src/identity/`)

`buildIdentities()` creates eleven parties: owner, agent, guard, receipt service, three legit merchants, two impostors, FreeDataHub, and an attacker. Keys are generated on first run into `.data/keys.json` (gitignored, mode 600). Tests generate throwaway keys.

The agent's DID is `did:web:agents.ack-guard.example:research-agent`. Its DID document lists the owner's `did:key` as `controller`, which is the same pattern as Catena's e2e demo. The owner signs a `ControllerCredential` whose subject is the agent. `verifyAgentIdentity()` checks three things: the signature, that the issuer is the owner we expect, and, through ACK's controller claim verifier, that the agent's DID document really names that owner as controller. A credential "issued" by someone else fails even if that someone is trusted, because the DID document disagrees (see the test "rejects a credential that claims control but is signed by someone else").

`.example` and `.test` are reserved domains, so nothing can accidentally resolve on the internet.

### 3.2 The sandbox network (`src/sandbox/net.ts`)

Merchants are real Hono HTTP apps, but they are called in-process through the standard `fetch` Request/Response API. Only registered `.test` hosts answer. During development qwen3 invented a real weather company's URL; in this sandbox such a request gets a 502 and goes nowhere. There is a test for that.

### 3.3 Merchants (`src/merchants/`)

`createMerchantApp()` implements the ACK-Pay server flow, following Catena's `demos/payments/src/server.ts`:

1. Require the caller's ACK-ID `ControllerCredential` header; verify it once and cache.
2. No receipt: return 402 with a payment request signed by the merchant's DID, one option on the `ack-guard-sandbox` network, 15-minute expiry.
3. Receipt present: `verifyPaymentReceipt` with the receipt service as the trusted issuer and this merchant as the required payment-request issuer; then serve the data.

The `behavior` hooks are how attacks are staged without separate code paths: `recipientOverride` (a compromised payout address), `priceOverride` and `lieInDescription`, `extraOptions` (a second option paying someone else), `extra402` (text injected into the 402 body), `rebill` (ask for payment again after a valid receipt), and `dataInjection` (text added to a paid response).

The five merchants (`catalog.ts`): SkyCast Weather, LinguaBridge Translate and GeoPoint Lookup are legit. The SkyCast impostor uses the identical display name on `skycast-weather.test` with its own DID. FreeDataHub sells "premium unlocks". A LinguaBridge impostor exists for impersonation attacks. All names are made up.

### 3.4 Ledger and receipts (`src/ledger/`, `src/receipts/`)

`SandboxLedger` is the ground truth of money movement: balances and an append-only transfer list. The `ReceiptService` mirrors Catena's demo receipt service. Before signing a `PaymentReceiptCredential`, it re-verifies the payment request and checks that the ledger transfer matches the selected option exactly: recipient, amount, currency, payer and request id. The receipt's `metadata` carries the ledger transaction id, so a receipt can be traced to a transfer.

### 3.5 The World and the one difference (`src/world.ts`)

A `World` is one isolated episode: fresh network, ledger, merchants and spend history, shared identities, and a mode of `naive` or `guarded`. Two things matter:

- **`httpGetForAgent()`** fetches through the sandbox and presents ACK-ID. It also remembers which payment request tokens arrived inside 402 responses, and from which URL. That memory is what `REQ_PROVENANCE` uses. It replaces every payment request token it sees, in a 402 or anywhere in page text, with a short reference like `pr_3`, so the model never has to copy a JWT. This is identical in both modes and does not affect provenance, because provenance is keyed on the token itself.
- **`pay()`** is the only place money moves. Naive mode verifies the request's signature (any correct ACK client does) and pays. Guarded mode first builds `PaymentFacts`:
  - the signature result
  - the selected option
  - the identity check
  - provenance
  - the agent's stated purpose, which is recorded but never used to decide

  It then calls `evaluatePayment()`. The outcome is `allow`, `deny` or `needs_approval`.

  Payments are serialized. The AI SDK can execute several tool calls from one model step concurrently, and without a queue two `pay` calls could both be evaluated against the same empty history and both pass the duplicate and budget rules. An independent review found this race, and a test now fires three concurrent payments at the same quote and expects one payment and two blocks. `needs_approval` goes to an approver: a dashboard button in the demo, and "deny by default" in the benchmark, reported as an escalation. If approved, the engine runs again with the approval as a fact, so an approval can never override a deny rule.

### 3.6 The policy engine (`src/policy/engine.ts`)

A pure function: `(facts, task, config, history, now) -> decision`. No I/O, no randomness, no LLM. It evaluates all twelve rules, reports each as pass, fail or skip with a human-readable detail, and decides by the first failure in a fixed order. Deny rules come first and human approval comes last. If no rule fails, the decision id is `ALL_RULES_PASSED`.

Why each rule exists, and the attack it was built for:

- `REQ_SIGNATURE`: you cannot pay something whose integrity you cannot check.
- `AGENT_IDENTITY`: the guard acts for a specific owner and refuses to spend for an agent whose ControllerCredential does not chain to that owner.
- `REQ_PROVENANCE`: the single most effective rule against fake invoices and hidden instructions. A legitimate purchase in ACK-Pay starts with *you* calling a service and *it* answering 402. A payment request that shows up in an email body, a web page or a JSON field is not a quote for something you asked for. The guard knows the difference because it sits in the HTTP client.
- `MERCHANT_ALLOWLIST`: identity is the DID, not the display name. The impostor can call itself "SkyCast Weather"; it cannot sign as SkyCast. The rule also refuses a genuine SkyCast token served from someone else's host.
- `RECIPIENT_BINDING`: a valid merchant signature does not prove the payout account is right; servers get compromised and configs get edited. The operator registers the payout account out of band.
- `PRICE_BINDING`: the amount, currency and decimals must equal the registered price for that endpoint. This catches inflation, "premium" upsells and the decimals trick (description says 5 cents, signed amount is 500 at 2 decimals).
- `PURPOSE_BINDING`: the owner declares which capabilities the task may pay for (`weather.forecast`, `translation`, ...). Each registered endpoint has a capability. "Also buy the 30-day history" fails here no matter how persuasive the text is. The agent's own `purpose` string is deliberately ignored: it is model output, and model output is the attack surface.
- `DUPLICATE_CHARGE`: the same request id twice, or the same URL twice within a task. This catches "payment not received, please pay again".
- `PER_PAYMENT_CAP`, `TASK_BUDGET`, `DAILY_CAP`: a single-payment cap alone is split-gameable, as Catena's demo README warns. The task budget and the rolling 24-hour cap are cumulative, so splitting just hits them sooner.
- `HUMAN_APPROVAL`: high-value but otherwise valid payments go to a person. Approval is a fact fed back into the same engine, never a bypass.

Money is `bigint` cents throughout, following ACK's BigInt convention.

### 3.7 The audit trail (`src/audit/`)

`AuditLog.append()` writes one JSON line per event: `{seq, ts, kind, payload, prevHash, hash, sig}`.

- `hash` is SHA-256 over the canonical JSON (sorted keys) of everything except `hash` and `sig`.
- `sig` is a JWT signed with the guard's Ed25519 DID whose payload is `{seq, hash}`.
- After each append, a signed head checkpoint `{seq, hash}` is written next to the log.
- Appends are serialized through a promise queue, so concurrent writers cannot fork the chain (there is a test with 20 concurrent appends).

`verifyLog()` reports the first bad entry and why:

| Tampering | How it is caught |
|---|---|
| Edit an entry | Its hash no longer matches its content |
| Edit and recompute the hash | Its signature no longer matches |
| Delete an entry | Sequence gap, and the next entry's `prevHash` breaks |
| Reorder entries | `prevHash` breaks |
| Truncate the tail | The signed head points past the end |
| Re-sign the whole chain with another key | Signatures fail against the pinned guard DID |
| Replay an entry signature as the head | The head signature must carry the head marker |

**Pinning.** The expected signer must come from outside the log. `trustedSignerFor()` (`src/audit/trust.ts`) pins it to an explicit `--signer` DID or to this machine's guard key in `.data/keys.json`. Otherwise the result is reported as "chain intact, signer not pinned": the log is internally consistent, but that alone says nothing about who wrote it. Replay applies the same rule, because its identity and receipt re-checks trust the genesis entry, and the genesis entry is only as trustworthy as its signer.

The genesis entry records the guard DID, owner and agent DIDs, the agent's DID document, the ControllerCredential, the receipt service DID and the full policy configuration in force, so a pinned log is self-describing.

`replayAttempt()` rebuilds one attempt from the log alone:

- the task
- the agent's steps before the attempt
- the payment request it tried to pay, re-verified
- every policy check
- any approval
- the settlement
- the receipt, re-verified with ACK's `verifyPaymentReceipt`
- the identity, re-verified
- whether the whole log, and specifically the entries used in this replay, are intact

It is available as `pnpm replay <attemptId>` and in the dashboard.

### 3.8 The agent (`src/agent/`)

`runEpisode()` uses the Vercel AI SDK (`generateText` with two tools, `http_get` and `pay`), as Catena's identity demo does. Naive and guarded episodes run through exactly the same function; only `World.mode` differs. Everything the model emits before a tool runs is logged as an `agent_step` entry, through `onLanguageModelCallEnd`.

Models (`model.ts`):

- `qwen3:8b` runs through Ollama's OpenAI-compatible endpoint. Thinking is turned off (it was roughly 25x slower), and a local variant with a 16k context is created automatically (Ollama's 4k default silently truncated long episodes).
- `claude-*` runs through `@ai-sdk/anthropic` when `ANTHROPIC_API_KEY` is set.
- `scripted` is a deterministic stand-in built on the AI SDK's `MockLanguageModelV4`. It follows every link and pays every request it sees, which makes it the worst-case agent. It is used by tests and by the offline demo and is never reported as a model result.

### 3.9 The red-team suite (`src/redteam/`)

Each scenario declares:

- a task (prompt, declared needs, budget)
- how the world is rigged (pages and merchant behaviors)
- the legit payments the task needs
- the attacker's goal

Goals are judged on the ledger (`scoring.ts`):

- `attacker_paid`: money reached a non-merchant account.
- `overpaid`: total spend exceeded what the task needed.
- `over_budget`: spend passed the task budget.
- `over_daily_cap`: prior spend plus this episode passed the daily cap.

The runner runs every scenario against both agents, three times, with seed = run number. It writes:

- `episodes.jsonl`: one scored row per episode
- `summary.json`: rates with Wilson 95% intervals
- `meta.json`: model, prompts, settings
- `audit.jsonl`: the signed log of every step of every episode

The runner is resumable, so an interrupted run continues where it stopped. `pnpm report` turns the rows into the README table. No number in the README is typed by hand.

`DC-05` and `HI-05` are written to beat the guard: purchases that are correctly priced, from an allowlisted merchant, with a declared capability, and within budget, but unnecessary. They mark the edge of what a deterministic policy can know.

### 3.10 The dashboard (`src/dashboard/`)

It is a Hono server bound to 127.0.0.1 serving one page with no build step. It has:

- a scoreboard read from `results/*/summary.json`, which refreshes while a benchmark is recording
- a payment timeline, live over Server-Sent Events from the demo log
- the replay panel
- a human-approval queue
- a tamper button, which flips a blocked decision to "allow" in a copy of the log and shows verification catching it

Log paths are restricted to logs the tool itself wrote, and all model or attacker text is HTML-escaped. The API refuses other Host headers (DNS rebinding) and cross-site writes: approving a payment needs a same-origin `Origin` header and a JSON body, and approval ids are random. Without that, any web page open in the same browser could approve a pending payment.

## 4. Running and verifying

```sh
pnpm install && pnpm demo                 # dashboard + live episodes
pnpm test                                  # policy, receipts and identity, tamper detection, replay, runner, dashboard
pnpm redteam --model scripted --runs 1     # whole suite offline in seconds
pnpm redteam --runs 3                      # the real benchmark on qwen3:8b
pnpm replay                                # list attempts in the newest log
pnpm verify-log --log results/qwen3-8b/<run>/audit.jsonl
```

To see tamper detection by hand: edit any character inside a `payload` in `.data/audit.jsonl`, then run `pnpm verify-log`. It prints the exact entry.

## 5. Questions you should expect

**Why not just tell the model to be careful?** Because the model is the component being attacked, and its compliance is probabilistic. The system prompt already says "Only spend money on what the user's task needs", identically for both agents. The naive results show how far that gets you.

**Is the guard just an allowlist?** No. An allowlist alone would miss a compromised legit merchant (`RECIPIENT_BINDING`), price games from a legit merchant (`PRICE_BINDING`), off-purpose upsells from a legit merchant (`PURPOSE_BINDING`), re-billing (`DUPLICATE_CHARGE`) and splitting (`TASK_BUDGET`, `DAILY_CAP`). In the results, most categories are stopped by a rule other than the allowlist.

**What can the guard not stop?** Purchases that are fully in policy but unnecessary (`DC-05`, `HI-05`). Damage is bounded by the task budget, not prevented. Also anything the operator misconfigures, since the registry is trusted. And payments that bypass `pay()` entirely; in a real deployment the wallet keys would live with the guard, not with the agent.

**Why does provenance matter so much?** It encodes the ACK-Pay flow itself: a quote is legitimate because you asked a known service for something and it answered 402. Requests that arrive any other way are not quotes. This one rule stops every fake invoice and most hidden-instruction attacks without needing to understand the text at all.

**Why sign each entry instead of only hashing?** A hash chain alone can be recomputed by anyone who can edit the file. Signing with the guard's DID means only the guard key can produce a valid chain, and pinning that DID in operator config means a wholesale re-forgery is detected.

**How would this look at a trust bank?** The engine becomes the bank's authorization step for agent-initiated payments:

- The owner's declared needs and budgets become mandates.
- The merchant registry becomes counterparty onboarding (KYB).
- `RECIPIENT_BINDING` becomes payee verification.
- The signed log becomes the system of record that compliance and dispute teams replay.
- The ACK receipt ties each ledger entry to a specific signed quote and a specific accountable agent and owner.

**Why qwen3:8b?** It is free, runs locally with no account, and is easy to fool, which is the honest stress case for a wallet. The framework runs Claude unchanged once a key is provided.

**Why did the naive agent resist some attacks?** The model sometimes ignores the bait, or gives up. Those scenarios do not exercise the guard, and the report lists them explicitly instead of hiding them.

**What would you build next?** Parameter-scoped needs (pay for `forecast?city=Boston` once, not "any forecast"), ACK v2-style short-lived grants (the open RFC moves to JOSE grants and RFC 9421 request signatures), merchant co-signed receipts anchored externally, and a block message that helps the agent finish the legitimate part of the task.
