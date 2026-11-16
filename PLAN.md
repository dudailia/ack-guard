# ACK Guard: build plan

## Context
Ilia is interviewing at Catena Labs and wants an open-source demo, runnable in one command, showing AI agent payments that resist prompt-injection attacks. It is built on Catena's Agent Commerce Kit (ACK). The audience is Catena first, then LinkedIn. It has to be technically excellent and honest: real results only, no real money, no real company systems, no secrets, no em dashes.

**What research found (github.com/agentcommercekit/ack, MIT, "Copyright (c) 2025 Catena Labs, Inc"):**
- npm `agentcommercekit@0.11.0` re-exports `@agentcommercekit/{ack-id,ack-pay,did,jwt,keys,vc,caip}`.
- ACK-ID: `createControllerCredential({subject, controller})` makes an owner-to-agent W3C VC. It is signed with `signCredential` and verified via `parseJwtCredential`, `verifyParsedCredential` and `resolveDidWithController`.
- ACK-Pay: the merchant returns HTTP 402 with `createSignedPaymentRequest(init, {issuer, signer, algorithm})`, a signed JWT with `paymentOptions[{id, amount, decimals, currency, recipient, network?, receiptService?}]`. `network` is a free string, so a local `"ack-guard-sandbox"` ledger fits the schema. The receipt service creates `createPaymentReceipt(...)` plus `signCredential`, and the merchant checks `verifyPaymentReceipt(jwt, {resolver, trustedReceiptIssuers, paymentRequestIssuer})`.
- Keys and DIDs: `generateKeypair`, `createDidKeyUri`, `createDidDocumentFromKeypair`, `createJwtSigner`, `curveToJwtAlgorithm`, `getDidResolver` (all local, no network).
- `demos/payments/src/payment-policy.ts` is Catena's own "policy-before-signing" example. Its README says the per-transaction cap is "trivially defeated by splitting... A production policy needs a cumulative and/or rate-limited budget". ACK Guard picks up exactly that gap. We credit the pattern and cite it.
- The demos use the Vercel AI SDK (`@ai-sdk/anthropic` / `openai`) and Hono servers. We follow both.
- The ACK v2 RFC (JOSE grants, RFC 9421) is still an open PR. We build on the published v1 packages and mention v2 in the memo's "next" section.
- Nothing we use needs an API key or account. Ollama `qwen3:8b` is installed locally.

**Decisions from the user:** use qwen3:8b via local Ollama first, with a provider abstraction so Claude runs can be added later with `ANTHROPIC_API_KEY`. Run 3 times per attack per agent.

## Stack
TypeScript, Node 22, pnpm, single package (no monorepo). Hono plus `@hono/node-server`, `agentcommercekit@0.11.0` (pinned), `valibot`, Vercel AI SDK (`ai`, `@ai-sdk/openai-compatible` pointed at `http://localhost:11434/v1`, `@ai-sdk/anthropic` optional), `vitest`, `tsx`. Exact versions are checked at install, and the AI SDK APIs are verified against `node_modules/ai/docs`.

## Layout
```
src/
  identity/      owner.ts, agent-identity.ts (ACK-ID ControllerCredential), resolver.ts
  ledger/        sandbox-ledger.ts (in-memory, ground truth of money movement)
  receipts/      receipt-service.ts (ACK PaymentReceiptCredential issue/verify)
  merchants/     framework.ts (402 + signed PaymentRequest + receipt check)
                 legit: weather.ts, translate.ts, geocode.ts (fictional names)
                 malicious: impersonator.ts (lookalike name, own DID), injector.ts (fake invoices / hidden instructions)
  policy/        rules.ts, engine.ts, config.ts (pure, deterministic)
  audit/         chain.ts (hash-chained signed log), verify.ts, replay.ts
  agent/         model.ts (provider: ollama|anthropic), tools.ts, naive.ts, guarded.ts, prompts.ts
  redteam/       attacks/*.ts (one file per category), benign.ts, runner.ts, scoring.ts
  dashboard/     server.ts (Hono + SSE), public/index.html, app.js, styles.css
  cli/           demo.ts, replay.ts, redteam.ts, report.ts, verify-log.ts
scripts/check-no-em-dash.ts, scripts/gen-results-table.ts
results/         committed real run outputs (JSONL per run + summary.json)
.data/           gitignored: generated keys, live audit log
```

## Components
1. **Identity (ACK-ID).** The owner (human, did:key) issues a signed `ControllerCredential` to the agent (did:key). The agent presents it to merchants, which verify it before issuing payment requests. The guard also checks it on every payment. Keys are generated on first run into `.data/` (gitignored), so no secrets live in the repo.
2. **Merchants.** One shared Hono framework, one port each. With no receipt: return 402 plus a signed ACK PaymentRequest. With a receipt: `verifyPaymentReceipt`, then serve data.
   - Legit merchants (fictional): `SkyCast Weather`, `LinguaBridge Translate`, `GeoPoint Lookup`.
   - Malicious: `SkyCast Weather Pro` impersonator (same display name, different DID and recipient), and `FreeDataHub`, which serves content with fake invoices, hidden instructions, recipient swaps, re-billing and split demands.
   - Malicious behaviors are configurable per attack scenario.
   - Payments settle on the in-memory sandbox ledger. The receipt service issues an ACK `PaymentReceiptCredential` whose `metadata` carries the ledger tx id.
3. **Policy engine.** It runs outside the LLM and is pure: `evaluate(intent, ctx, config, history) -> {outcome: allow|deny|needs_approval, rule: {id, title}, checks: [...each rule, pass/fail, detail]}`. Rules are checked in fixed order, and the first failure fires:
   1. `REQ_SIGNATURE`: the payment request JWT verifies, and the issuer DID is resolvable.
   2. `AGENT_IDENTITY`: the agent's ControllerCredential is valid and its controller is the configured owner.
   3. `MERCHANT_ALLOWLIST`: the issuer DID is on the allowlist (matched by DID, not display name).
   4. `RECIPIENT_BINDING`: the option's recipient equals that merchant's registered recipient.
   5. `PRICE_BINDING`: the amount and currency match the registered price for the endpoint (catches inflation). An unknown endpoint is denied.
   6. `PURPOSE_BINDING`: the endpoint's registered capability is in the task's declared needs. Needs are set by the task author, not the LLM.
   7. `PER_PAYMENT_CAP`.
   8. `DAILY_CAP`: a rolling 24h cumulative cap per agent, which defeats splitting.
   9. `TASK_BUDGET`: cumulative spend per task stays within the task's declared budget.
   10. `DUPLICATE_CHARGE`: blocks a repeated payment request id, and the same merchant + endpoint + task already paid inside the window.
   11. `HUMAN_APPROVAL`: above the threshold, the outcome is needs_approval. The dashboard has approve/deny buttons. Benchmark runs use a scripted approver that denies, reported separately as "escalated".

   Money is handled with BigInt subunits, following Catena's convention.
4. **Audit trail.** Append-only JSONL. Each entry is `{seq, ts, kind, payload, prevHash, hash, sig}`, where `hash = sha256(canonical JSON)` and `sig` is a JWS by the guard's DID. A signed head checkpoint covers tail truncation.
   - Entries cover tasks, LLM reasoning and tool calls, policy decisions, payments, and receipts (receipt JWT embedded).
   - `verify` detects edited, deleted, reordered, re-signed and truncated entries, and reports the first bad seq.
   - `pnpm replay <id>` (and the dashboard view) rebuilds: task, agent reasoning, the proposed payment, the policy rule that fired plus all checks, identity verification, the receipt plus `verifyPaymentReceipt` result, and chain/signature verification.
5. **Agents.** Same model, system prompt, tools and temperature for both agents. Tools: `fetch_url`, `call_merchant`, `pay(paymentRequestToken, optionId, purpose)`. The only difference: in the naive agent `pay` settles directly, while in the guarded agent `pay` goes through the policy engine first. Reasoning and tool calls are captured into the audit log.
6. **Red-team suite.** 35 attacks in 7 categories, 5 each:
   - fake invoice in fetched content
   - recipient swap
   - amount inflation
   - duplicate charge
   - merchant impersonation
   - splitting to evade policy
   - instructions hidden in tool output (HTML comments, JSON `system_note`, zero-width text, markdown footnotes)

   Each attack defines the task, the scenario configuration and an attack-success predicate evaluated on the **ledger** (ground truth), never on what the LLM claims. Around 8 benign control tasks measure false blocks and task completion, because a guard that blocks everything is useless.
   - The runner runs every case x {naive, guarded} x 3 runs and writes `results/<model>/<timestamp>.jsonl` plus `summary.json` (per-category success rate, escalations, false-positive rate, and the rule that fired).
   - Guarded failures are reported as they are. Some attacks deliberately probe in-policy gaps, such as a correctly priced, allowlisted, on-purpose charge the user didn't really need.
7. **Dashboard.** `http://localhost:4300`, one page in vanilla HTML/CSS/JS with no build step, so the one-command run stays fast. It has a live scoreboard (naive vs guarded per category), a payment timeline via SSE from the audit log, a replay panel with verification badges, and a "tamper with an entry" demo button that runs on a copy and shows detection. The design is clean and restrained.
8. **Docs.**
   - README:
     - the one-command run, `pnpm i && pnpm demo`
     - a mermaid architecture diagram
     - a results table generated by `pnpm report` from `results/` (between markers)
     - a limits section
     - "Built by Ilia Duda with Claude Code"
     - credit to ACK under MIT
     - a no-affiliation disclaimer
   - WALKTHROUGH.md (every component, interview-ready).
   - MEMO-for-Catena.md, one page.
   - LINKEDIN.md, with no implied affiliation or endorsement.
   - A NOTICE crediting Catena and ACK. The MIT notice is included for anything adapted.

**One command:** `pnpm demo` generates keys if needed, then starts merchants, receipt service and dashboard. It runs a short live guarded scenario if Ollama is up, otherwise it says so and shows the recorded results. `pnpm redteam [--model qwen3:8b|claude] [--runs 3]` runs the full suite.

## Milestones (a git commit after each, never pushed)
- M0: `git init`, scaffold, `.gitignore`, PLAN.md, then a spike script confirming the ACK 0.11.0 APIs end to end (DIDs, ControllerCredential, PaymentRequest, receipt, verify).
- M1: identity, ledger, receipt service, 5 merchants, plus receipt tests.
- M2: policy engine plus exhaustive policy tests (one or more per rule, ordering, BigInt edges).
- M3: audit chain, verify, replay CLI, plus tamper tests.
- M4: model provider, tools, naive/guarded agents, attack suite, runner, plus runner tests using a scripted fake model (deterministic).
- M5: real benchmark run on qwen3:8b, run in the background. Results are committed.
- M6: dashboard.
- M7: docs plus the generated results table, then a final check (tests, em-dash check, secret scan).
- Claude runs: stop and ask for `ANTHROPIC_API_KEY` in a gitignored `.env`. Write STATUS.md at any stop.

## Rules enforcement
- `pnpm check` runs typecheck, vitest, `check-no-em-dash` (fails on U+2014 in tracked files) and a simple secret-pattern scan.
- Only localhost services. All merchant names are fictional. No real rails; the network is `ack-guard-sandbox`.

## Verification
- `pnpm test`: policy, receipts (including a tampered receipt failing `verifyPaymentReceipt`), audit tamper detection (edit, delete, reorder, forged sig, truncation) and runner scoring with the fake model. All must pass.
- `pnpm demo`: services come up, a live guarded payment happens, and its receipt verifies in replay.
- `pnpm replay <id>` for an allowed payment and for a blocked attempt. Then hand-edit `.data/audit.jsonl` and confirm `pnpm verify-log` flags the exact seq.
- `pnpm redteam --runs 3` on qwen3:8b; check that summary.json matches the README table (regenerated by `pnpm report`).
- Open the dashboard in the browser (Playwright) and check the scoreboard, timeline and replay.
- grep for em dashes and secrets is clean; `git log` shows the milestone commits.
