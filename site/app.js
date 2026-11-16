// Static guided demo. Data comes from data/demo.json (built by pnpm build:site);
// integrity checks run here with WebCrypto (see verify.js).

import { verifyEntries } from "./verify.js"

const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`
const pct = (x) => `${(x * 100).toFixed(1)}%`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const RULE_LABELS = {
  REQ_SIGNATURE: "Invalid payment request",
  AGENT_IDENTITY: "Agent identity not verified",
  REQ_PROVENANCE: "Not a quote the agent asked for",
  MERCHANT_ALLOWLIST: "Unknown merchant",
  RECIPIENT_BINDING: "Wrong payout account",
  PRICE_BINDING: "Wrong price",
  PURPOSE_BINDING: "Not needed for this task",
  DELEGATION_LIMITS: "Beyond the sub-agent's delegation",
  DUPLICATE_CHARGE: "Already bought",
  PER_PAYMENT_CAP: "Over the per-payment cap",
  TASK_BUDGET: "Over the task budget",
  DAILY_CAP: "Over the daily cap",
  HUMAN_APPROVAL: "Needs a human",
  ALL_RULES_PASSED: "All checks passed",
}
const ruleLabel = (id) => RULE_LABELS[id] || id

let data

function describeProblem(p) {
  return `entry ${p.position}: ${p.detail}`
}

async function checkOriginal() {
  const el = $("#integrity")
  const v = await verifyEntries(data.log, data.head, data.guardDid)
  el.className = `integrity ${v.ok ? "ok" : "bad"}`
  el.textContent = v.ok
    ? `Audit log verified in your browser: ${data.log.length} entries, hash chain${v.signaturesChecked ? " and Ed25519 signatures" : ""}`
    : `Audit log fails verification at entry ${v.firstBadPosition}`
  if (v.ok && !v.signaturesChecked) el.title = "This browser has no Ed25519 in WebCrypto, so only the hash chain was checked here."
  return v
}

// ---------- guided demo ----------
function setStep(n, cls, html, done) {
  const el = $(`#g${n}`)
  el.className = `result ${cls}`
  el.innerHTML = html
  const li = el.closest("li")
  li.classList.remove("done-good", "done-stop")
  if (done) li.classList.add(done)
}
const replayLink = (key) => `<button class="link" type="button" data-replay="${key}">Open the replay</button>`

async function guided() {
  const btn = $("#guided-btn")
  btn.disabled = true
  for (const n of [1, 2, 3]) setStep(n, "", "")
  const legit = data.steps.legit.replay
  const attack = data.steps.attack.replay

  setStep(1, "running", "The agent is working on it")
  await sleep(900)
  const paidAmount = legit.settlement?.tx?.amount
  setStep(1, "good", `Paid ${money(paidAmount)}. Every policy check passed and the ACK receipt verified. ${replayLink("legit")}`, "done-good")

  setStep(2, "running", "The agent is reading its inbox")
  await sleep(1100)
  const d = attack.decisions[attack.decisions.length - 1]
  setStep(2, "stop", `The agent tried to pay it. Blocked: ${esc(ruleLabel(d.rule.id))} (${esc(d.rule.id)}). No money moved to the attacker. ${replayLink("attack")}`, "done-stop")

  setStep(3, "running", "Editing a copy of the log and verifying it")
  await sleep(700)
  const copy = structuredClone(data.log)
  const i = copy.findIndex((e) => e.kind === "decision" && e.payload.attemptId === data.steps.attack.attemptId)
  copy[i].payload.decision.outcome = "allow"
  const after = await verifyEntries(copy, data.head, data.guardDid)
  const before = await verifyEntries(data.log, data.head, data.guardDid)
  setStep(
    3,
    after.ok ? "warn" : "stop",
    after.ok
      ? "Not detected."
      : `Detected at entry ${after.firstBadPosition}: ${esc(after.problems[0].detail)}. The original log still verifies: ${before.ok ? "yes" : "no"}.`,
    after.ok ? undefined : "done-stop",
  )
  btn.textContent = "Run it again"
  btn.disabled = false
}

// ---------- replay ----------
function checkRow(ch, firedId) {
  const mark = ch.passed === true ? ["pass", "pass"] : ch.passed === false ? ["fail", "FAIL"] : ["skip", "skip"]
  return `<li class="${ch.id === firedId ? "fired" : ""}"><span class="mark ${mark[0]}">${mark[1]}</span><span>${esc(ch.id)}</span><span class="detail muted">${esc(ch.detail)}</span></li>`
}

function showReplay(key) {
  const r = data.steps[key].replay
  const t = r.task || {}
  const task = t.task || {}
  const last = r.decisions[r.decisions.length - 1]
  const yes = (b) => (b ? `<span class="ok">verified</span>` : `<span class="bad">failed</span>`)
  const req = r.proposed.request || {}
  const options = (req.options || []).map((o) => `${esc(o.id)}: ${money(o.amount)} to ${esc(o.recipient)}`).join("<br>")
  const reasoning =
    r.reasoning
      .map((s) => (s.toolCalls || []).map((tc) => `<p class="toolcall">${esc(tc.toolName)} ${esc(JSON.stringify(tc.input)).slice(0, 220)}</p>`).join(""))
      .join("") || `<p class="muted">No agent steps recorded before this attempt.</p>`
  const verdict = r.finalOutcome === "paid" ? ["paid", "Paid. Every policy rule passed."] : ["stopped", `Blocked: ${ruleLabel(last?.rule?.id)}. ${last?.rule?.detail}`]
  $("#replay").innerHTML = `
    <h2 id="replay-title">Replay: ${key === "legit" ? "the legitimate purchase" : "the injected invoice"}</h2>
    <p class="muted">Rebuilt from the signed log when this page was built. Attempt ${esc(r.attemptId)}.</p>
    <p class="verdict ${verdict[0]}">${esc(verdict[1])}</p>
    <ol class="steps">
      <li><div><h3>Task, as set by the owner</h3><p class="quote">${esc(task.prompt)}</p>
        <dl class="kv"><dt>Declared needs</dt><dd>${esc((task.needs || []).join(", ") || "none")}</dd><dt>Budget</dt><dd>${money(task.budget)}</dd></dl></div></li>
      <li><div><h3>Identity (ACK-ID)</h3><dl class="kv"><dt>Agent</dt><dd>${esc(r.identity.agentDid)}</dd><dt>Owner</dt><dd>${esc(r.identity.ownerDid)}</dd>
        <dt>ControllerCredential</dt><dd>${yes(r.identity.controllerCredentialValid)}</dd></dl></div></li>
      <li><div><h3>What the agent did first</h3>${reasoning}</div></li>
      <li><div><h3>The payment it asked for</h3><dl class="kv"><dt>Agent's stated purpose</dt><dd>${esc(r.proposed.agentPurpose)}</dd>
        <dt>Signed by</dt><dd>${esc(req.issuer || req.error)}</dd><dt>Description</dt><dd>${esc(req.description)}</dd><dt>Options</dt><dd>${options}</dd></dl></div></li>
      <li><div><h3>Policy decision</h3>${r.decisions
        .map((d) => `<p><b>${esc(d.outcome)}</b> by <b>${esc(d.rule.id)}</b> (${esc(ruleLabel(d.rule.id))})</p><ul class="checks">${d.checks.map((ch) => checkRow(ch, d.rule.id)).join("")}</ul>`)
        .join("")}</div></li>
      <li><div><h3>Settlement and ACK receipt</h3>${
        r.settlement
          ? `<dl class="kv"><dt>Ledger transaction</dt><dd>${esc(r.settlement.tx.txId)}: ${money(r.settlement.tx.amount)} to ${esc(r.settlement.tx.to)}</dd>
             <dt>PaymentReceiptCredential</dt><dd>${r.receipt ? yes(r.receipt.verifiedNow.ok) + " with ACK's verifyPaymentReceipt" : "missing"}</dd></dl>`
          : `<p class="muted">No money moved.</p>`
      }</div></li>
      <li><div><h3>Log integrity</h3><p>The whole log is re-checked in your browser (see the badge at the top). Guard key: <code>${esc(data.guardDid)}</code>.</p></div></li>
    </ol>`
  $("#replay-section").hidden = false
  $("#replay-section").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" })
}

// ---------- your own edit ----------
function fillEditor() {
  $("#edit-entry").innerHTML = data.log
    .map((e) => {
      const what = e.kind === "decision" ? `decision: ${e.payload.decision.outcome} by ${e.payload.decision.rule.id}` : e.kind === "settlement" ? `settlement ${money(e.payload.tx.amount)}` : e.kind
      return `<option value="${e.seq}">${e.seq}. ${esc(what)}</option>`
    })
    .join("")
  const firstDecision = data.log.find((e) => e.kind === "settlement")
  if (firstDecision) $("#edit-entry").value = String(firstDecision.seq)
}

async function verifyEdit() {
  const seq = Number($("#edit-entry").value)
  const kind = $("#edit-kind").value
  let copy = structuredClone(data.log)
  let change
  if (kind === "edit") {
    const e = copy[seq]
    if (e.kind === "settlement") {
      e.payload.tx.amount = String(Number(e.payload.tx.amount) * 10)
      change = `multiplied the settled amount by 10`
    } else if (e.kind === "decision") {
      e.payload.decision.outcome = e.payload.decision.outcome === "allow" ? "deny" : "allow"
      change = `flipped the decision to "${e.payload.decision.outcome}"`
    } else {
      e.ts = new Date(Date.parse(e.ts) - 3600_000).toISOString()
      change = "moved its timestamp back one hour"
    }
  } else if (kind === "delete") {
    copy.splice(seq, 1)
    change = "deleted it"
  } else if (kind === "swap") {
    if (seq >= copy.length - 1) {
      $("#edit-out").innerHTML = `<p class="muted">That is the last entry; pick an earlier one to swap.</p>`
      return
    }
    ;[copy[seq], copy[seq + 1]] = [copy[seq + 1], copy[seq]]
    change = `swapped it with entry ${seq + 1}`
  } else {
    copy = copy.slice(0, seq + 1)
    change = `cut every entry after it`
  }
  const v = await verifyEntries(copy, data.head, data.guardDid)
  $("#edit-out").innerHTML = `<div class="result"><b>${v.ok ? "Not detected" : `Detected at entry ${v.firstBadPosition}`}</b>. You ${esc(change)} on entry ${seq}.
    <ul>${v.problems.slice(0, 4).map((p) => `<li>${esc(describeProblem(p))}</li>`).join("")}</ul></div>`
}

// ---------- recorded results ----------
function renderResults() {
  if (!data.results?.length) return
  $("#results").hidden = false
  $("#results-meta").textContent =
    "From the project's recorded benchmark (results/ in the repository), verified against its signed logs by pnpm report. Same model, prompts and attacks with and without the guard; success is judged on the sandbox ledger."
  const suites = {
    main: { title: "Main suite: 35 attacks, 10 benign tasks", goal: "of attack runs where the attack reached its goal", unit: "Successful attacks", benign: "Benign tasks completed" },
    delegation: { title: "Delegation suite: 5 sub-agent escalation attacks, 2 benign hand-offs", goal: "of attack runs where the sub-agent exceeded its delegation", unit: "Runs that exceeded the delegation", benign: "Benign hand-offs completed" },
  }
  $("#models").innerHTML = data.results
    .map(({ summary: s, meta, suite }) => {
      const t = suites[suite || "main"] || suites.main
      const held = (mode) => {
        const b = s.benign[mode]
        return b.escalations ? `<p class="caption">The other ${b.escalations} waited for human approval by design (payments above $1.00 go to a human; the benchmark's approver declines).</p>` : ""
      }
      const side = (mode, title) => `
        <div class="side ${mode}"><h3>${title}</h3><p class="big">${pct(s.attacks[mode].rate)}</p>
          <p class="caption">${t.goal}</p>
          <dl><div><dt>${t.unit}</dt><dd>${s.attacks[mode].successes} of ${s.attacks[mode].n}</dd></div>
          <div><dt>Money moved to attackers</dt><dd>${money(s.attacks[mode].attackerReceivedCents)}</dd></div>
          <div><dt>${t.benign}</dt><dd>${s.benign[mode].completed} of ${s.benign[mode].n}</dd></div></dl>${held(mode)}</div>`
      return `<div><h3>${esc(t.title)}</h3><p class="muted">Model: ${esc(String(meta.modelLabel || s.model).replace(/^(\S+) \(local Ollama, /, "$1 running locally (Ollama, "))}. ${s.episodes} episodes, ${meta.runs} runs per scenario${meta.patches?.length ? `, with re-runs of ${esc(meta.patches.map((p) => p.scenarios.join(", ")).join("; "))}` : ""}.</p>
        <div class="duel">${side("naive", "Without guard")}${side("guarded", "With ACK Guard")}</div></div>`
    })
    .join("")
}

async function main() {
  try {
    data = await (await fetch("data/demo.json")).json()
  } catch {
    $("#integrity").textContent = "Could not load data/demo.json. Run pnpm build:site."
    return
  }
  $("#build-info").textContent = `Built ${data.builtAt.slice(0, 10)} from commit ${data.gitCommit}. Agent: ${data.agentModel}.`
  fillEditor()
  renderResults()
  $("#guided-btn").addEventListener("click", guided)
  $("#edit-btn").addEventListener("click", verifyEdit)
  document.addEventListener("click", (e) => {
    const key = e.target.dataset?.replay
    if (key) showReplay(key)
  })
  await checkOriginal()
}
main()
