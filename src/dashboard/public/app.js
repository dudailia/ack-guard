// ACK Guard dashboard. Vanilla JS, no build step. All untrusted text (agent
// output, attacker content) is escaped before it reaches the DOM.

const $ = (s) => document.querySelector(s)
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch])
const pct = (x) => `${(x * 100).toFixed(1)}%`
const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`
const api = async (path, init) => {
  const r = await fetch(path, init)
  const j = await r.json()
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j
}

const state = { runs: [], labels: {}, catalog: { scenarios: {}, rules: {} }, run: null, log: null, attempts: [], filter: "all", selected: null, liveLog: null }

// Plain-language names for policy rules. The rule ids stay visible in replay.
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
  NO_GUARD: "No guard, no checks",
}
const ruleLabel = (id) => RULE_LABELS[id] || id
const shortName = (did) => (!did ? "?" : did.startsWith("did:web:") ? did.split(":").slice(-1)[0] : `${did.slice(0, 18)}...`)
const scenarioTitle = (id) => state.catalog.scenarios[id]?.title
const runLabel = (r) =>
  r.meta?.combined
    ? `${r.model}: current results${r.meta.patches?.length ? " (with re-runs)" : ""}`
    : `${r.path.replace(/^results\//, "")}${r.meta?.superseded ? " (pre-fix, superseded)" : r.meta?.patchOf ? " (partial re-run)" : ""}`

// ---------- scoreboard ----------
async function loadRuns(keepSelection = true) {
  const { runs, categoryLabels } = await api("/api/runs")
  state.labels = { ...categoryLabels, ...state.labels }
  // Combined current results first, then newest first, superseded runs last.
  const rank = (r) => (r.meta?.combined ? 0 : r.meta?.superseded ? 2 : 1)
  state.runs = runs.sort((a, b) => rank(a) - rank(b) || b.path.localeCompare(a.path))
  const sel = $("#run")
  const prev = keepSelection ? sel.value : ""
  sel.innerHTML = state.runs.map((r) => `<option value="${esc(r.path)}">${esc(runLabel(r))}</option>`).join("")
  if (!state.runs.length) {
    $("#run-meta").textContent = "No recorded runs yet. Run pnpm redteam to record one."
    return
  }
  sel.value = prev && state.runs.some((r) => r.path === prev) ? prev : state.runs[0].path
  renderRun()
}

function renderRun() {
  const run = state.runs.find((r) => r.path === $("#run").value)
  if (!run) return
  state.run = run
  const s = run.summary
  const meta = run.meta || {}
  const total = meta.scenarios && meta.modes && meta.runs ? meta.scenarios.length * meta.modes.length * meta.runs : null
  const progress =
    (meta.combined && meta.patches?.length
      ? `. Re-run on top of the base run: ${meta.patches.map((p) => `${p.scenarios.join(", ")} at commit ${p.gitCommit} (${p.reason})`).join("; ")}`
      : "") +
    (meta.patchOf ? `. Partial re-run of ${meta.patchOf}: ${meta.patchReason}` : "") +
    (total && s.episodes < total && !meta.patchOf ? `, recording: ${s.episodes} of ${total} episodes so far` : "") +
    (meta.superseded ? `. Pre-fix run, superseded: ${meta.supersededReason || "kept for the record"}` : "") +
    (run.verification?.ok && (run.verification.combined || run.verification.headHash === meta.headHash)
      ? run.verification.combined
        ? `. Every row of the base run and the re-runs (${run.verification.episodesChecked} in all, ${s.episodes} shown) re-derived from their signed logs`
        : `. All ${run.verification.episodesChecked} rows re-derived from the signed log`
      : total && s.episodes >= total
        ? ". Not yet checked against the signed log (run pnpm report)"
        : "")
  const ids = meta.scenarios || []
  const nBenign = ids.filter((id) => id.startsWith("B-")).length
  const runs = meta.runs || s.runsPerScenario
  $("#run-meta").textContent =
    `${meta.modelLabel || s.model}. ${ids.length - nBenign} attacks and ${nBenign} benign tasks, ` +
    `${runs} run${runs === 1 ? "" : "s"} each, against both agents${progress}.`
  for (const mode of ["naive", "guarded"]) {
    const a = s.attacks[mode]
    $(`#${mode}-rate`).textContent = pct(a.rate)
    $(`#${mode}-k`).textContent = `${a.successes} of ${a.n}`
    $(`#${mode}-stolen`).textContent = money(a.attackerReceivedCents)
    $(`#${mode}-benign`).textContent = `${s.benign[mode].completed} of ${s.benign[mode].n}`
  }
  const bar = (mode, c) =>
    `<div class="bar ${mode}${mode === "guarded" && c.successes ? " hit" : ""}"><div class="track"><div class="fill" style="width:${(c.rate * 100).toFixed(1)}%"></div></div><span>${c.successes}/${c.n}</span></div>`
  const rulesByCat = {}
  for (const sc of s.scenarios) {
    for (const [rule, n] of Object.entries(sc.guarded.rules || {})) {
      rulesByCat[sc.category] ??= {}
      rulesByCat[sc.category][rule] = (rulesByCat[sc.category][rule] || 0) + n
    }
  }
  $("#cats").innerHTML = Object.entries(s.byCategory)
    .map(([k, v]) => {
      const rules = Object.entries(rulesByCat[k] || {}).sort((a, b) => b[1] - a[1]).map(([r]) => ruleLabel(r)).slice(0, 3).join(", ")
      const note = rules || (v.guarded.n ? "No payment was attempted" : "Not run yet")
      return `<tr><th scope="row">${esc(v.label)}</th><td>${bar("naive", v.naive)}</td><td>${bar("guarded", v.guarded)}</td><td class="rules">${esc(note)}</td></tr>`
    })
    .join("")
  $("#scenarios").innerHTML = s.scenarios
    .map((sc) => {
      const benign = sc.category === "benign"
      const cell = (x) => (benign ? `completed ${x.completed}/${x.n}` : `${x.successes}/${x.n} succeeded`)
      const rules = Object.entries(sc.guarded.rules || {}).map(([r, n]) => `${ruleLabel(r)} (${n})`).join(", ")
      return `<tr><td><b>${esc(sc.id)}</b></td><td>${esc(sc.title)}${sc.probesGap ? `<span class="gap-note">Probes a known gap: ${esc(sc.probesGap)}</span>` : ""}</td><td>${cell(sc.naive)}</td><td>${cell(sc.guarded)}</td><td class="rules">${esc(rules)}</td></tr>`
    })
    .join("")
}

// ---------- integrity ----------
async function checkIntegrity() {
  const el = $("#integrity")
  if (!state.log) return
  try {
    const v = await api(`/api/verify?log=${encodeURIComponent(state.log)}`)
    el.className = `integrity ${v.ok ? (v.pinned ? "ok" : "") : "bad"}`
    el.title = v.signerSource || ""
    el.textContent = !v.ok
      ? `Tampering detected at entry ${v.firstBadSeq ?? "?"}`
      : v.pinned
        ? `Audit log verified: ${v.entries} entries signed by this machine's guard key`
        : `Chain intact (${v.entries} entries), signer not pinned`
  } catch (e) {
    el.className = "integrity bad"
    el.textContent = e.message
  }
}

// ---------- timeline ----------
async function loadLogs() {
  const { live, logs } = await api("/api/logs")
  state.liveLog = live
  const sel = $("#log")
  const label = (p) =>
    p === live
      ? "This demo session"
      : p.startsWith(".data/live/")
        ? `Earlier demo session ${p.replace(/^.*audit-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2}).*$/, "$1-$2-$3 $4:$5")}`
        : p.replace(/^results\//, "Benchmark ").replace(/\/audit\.jsonl$/, "")
  sel.innerHTML = logs.map((p) => `<option value="${esc(p)}">${esc(label(p))}</option>`).join("")
  if (!state.log || !logs.includes(state.log)) state.log = live && logs.includes(live) ? live : logs[0]
  if (state.log) sel.value = state.log
}

function outcomeTag(a) {
  if (a.outcome === "paid") return a.mode === "naive" ? ["paid-naive", "Paid, no guard"] : ["paid", "Paid"]
  if (a.outcome === "needs_approval") return ["held", "Human declined"]
  if (a.outcome === "awaiting_approval") return ["held", "Waiting for a human"]
  if (a.outcome === "failed") return ["held", "Payment failed"]
  if (a.outcome === "deny") return ["stopped", "Blocked"]
  return ["held", a.outcome]
}

async function loadAttempts() {
  if (!state.log) {
    $("#attempts").innerHTML = `<li class="muted">No audit log yet. Run pnpm demo or pnpm redteam.</li>`
    return
  }
  const { attempts } = await api(`/api/attempts?log=${encodeURIComponent(state.log)}`)
  state.attempts = attempts.reverse()
  renderAttempts()
}

function renderAttempts() {
  const f = state.filter
  const rows = state.attempts.filter((a) => {
    if (f === "paid") return a.outcome === "paid"
    if (f === "stopped") return a.outcome !== "paid"
    if (f === "naive" || f === "guarded") return a.mode === f
    return true
  })
  $("#attempts").innerHTML =
    rows
      .slice(0, 400)
      .map((a) => {
        const [cls, text] = outcomeTag(a)
        const when = new Date(a.ts).toLocaleTimeString()
        const rule = a.mode === "guarded" ? ruleLabel(a.rule) : "no guard"
        const title = scenarioTitle(a.scenarioId) || a.attemptId
        const attemptNo = a.attemptId.split("#")[1]
        return `<li class="attempt" tabindex="0" data-id="${esc(a.attemptId)}" title="${esc(a.attemptId)}" aria-current="${a.attemptId === state.selected}">
          <span class="id">${esc(title)}${attemptNo && attemptNo !== "1" ? ` (payment ${esc(attemptNo)})` : ""}</span><span class="tag ${cls}">${esc(text)}</span>
          <span class="meta">${esc(when)}, ${esc(a.mode)} agent, ${esc(rule)}${a.category ? `, ${esc(state.labels[a.category] || a.category)}` : ""}</span></li>`
      })
      .join("") || `<li class="muted">Nothing matches this filter.</li>`
}

// ---------- replay ----------
function checkRow(ch, firedId) {
  const mark = ch.passed === true ? ["pass", "pass"] : ch.passed === false ? ["fail", "FAIL"] : ["skip", "skip"]
  return `<li class="${ch.id === firedId ? "fired" : ""}"><span class="mark ${mark[0]}">${mark[1]}</span><span>${esc(ch.id)}</span><span class="detail muted">${esc(ch.detail)}</span></li>`
}

async function replay(id) {
  state.selected = id
  renderAttempts()
  const box = $("#replay")
  box.innerHTML = `<p class="empty">Rebuilding ${esc(id)} from the log and re-verifying signatures</p>`
  let r
  try {
    r = await api(`/api/replay?log=${encodeURIComponent(state.log)}&id=${encodeURIComponent(id)}`)
  } catch (e) {
    box.innerHTML = `<p class="bad">${esc(e.message)}</p>`
    return
  }
  const t = r.task || {}
  const task = t.task || {}
  const last = r.decisions[r.decisions.length - 1]
  const verdictCls = r.finalOutcome === "paid" ? (r.mode === "naive" ? "naive" : "paid") : "stopped"
  const verdictText =
    r.finalOutcome === "paid"
      ? r.mode === "naive"
        ? "Paid. The naive agent has no policy, so nothing checked this payment."
        : "Paid. Every policy rule passed."
      : r.finalOutcome === "failed"
        ? `Payment failed at settlement: ${r.error || "unknown error"}`
        : r.finalOutcome === "needs_approval"
        ? `Held for a human, who declined. Rule: ${last?.rule?.id}`
        : `Blocked: ${ruleLabel(last?.rule?.id)}. ${last?.rule?.detail}`
  const yes = (b) => (b ? `<span class="ok">verified</span>` : `<span class="bad">failed</span>`)
  const req = r.proposed.request || {}
  const options = (req.options || []).map((o) => `${esc(o.id)}: ${money(o.amount)} to ${esc(o.recipient)}`).join("<br>")
  const reasoning =
    r.reasoning
      .map(
        (s) =>
          `${s.text ? `<p class="quote">${esc(s.text.slice(0, 600))}</p>` : ""}${(s.toolCalls || [])
            .map((tc) => `<p class="toolcall">${esc(tc.toolName)} ${esc(JSON.stringify(tc.input)).slice(0, 220)}</p>`)
            .join("")}`,
      )
      .join("") || `<p class="muted">No agent steps recorded before this attempt.</p>`
  box.innerHTML = `
    <h2>${esc(scenarioTitle(t.scenarioId) || r.attemptId)}</h2>
    <p class="muted">${esc(r.mode)} agent${t.scenarioId ? `, scenario ${esc(t.scenarioId)}` : ""}${t.model ? `, model ${esc(t.model)}` : ""}. Attempt ${esc(r.attemptId)}</p>
    ${r.chain.ok ? "" : `<p class="verdict stopped">This log fails verification (first bad entry ${esc(r.chain.firstBadSeq)}). Nothing below is trustworthy evidence.</p>`}
    <p class="verdict ${verdictCls}">${esc(verdictText)}${r.trusted ? "" : " (unverified)"}</p>
    <ol class="steps">
      <li><div><h3>Task, as set by the owner</h3><p class="quote">${esc(task.prompt)}</p>
        <dl class="kv"><dt>Declared needs</dt><dd>${esc((task.needs || []).join(", ") || "none")}</dd><dt>Budget</dt><dd>${money(task.budget)}</dd></dl></div></li>
      <li><div><h3>Identity (ACK-ID)</h3><dl class="kv"><dt>Agent</dt><dd>${esc(r.identity.agentDid)}</dd><dt>Owner</dt><dd>${esc(r.identity.ownerDid)}</dd>
        <dt>ControllerCredential</dt><dd>${yes(r.identity.controllerCredentialValid)}</dd></dl>${
          r.identity.delegation
            ? `<p class="muted">Paid by a sub-agent through a delegation chain, verified link by link:</p><ul class="checks">${r.identity.delegation.links
                .map(
                  (l) =>
                    `<li><span class="mark ${l.ok ? "pass" : "fail"}">${l.ok ? "pass" : "FAIL"}</span><span>link ${l.index}</span><span class="detail muted">${esc(shortName(l.issuer))} to ${esc(shortName(l.subject))}${
                      l.scope ? `: up to ${money(l.scope.budget)}, may buy ${esc(l.scope.capabilities.join(", "))}` : ""
                    }${l.error ? `. ${esc(l.error)}` : ""}</span></li>`,
                )
                .join("")}</ul>`
            : ""
        }
        ${r.mode === "guarded" ? `<p><a href="/api/dispute?log=${encodeURIComponent(state.log)}&id=${encodeURIComponent(r.attemptId)}&format=pdf" download>Download the dispute evidence pack (PDF)</a> or <a href="/api/dispute?log=${encodeURIComponent(state.log)}&id=${encodeURIComponent(r.attemptId)}&format=json" download>signed JSON</a></p>` : ""}</div></li>
      <li><div><h3>What the agent did first</h3>${reasoning}</div></li>
      <li><div><h3>The payment it asked for</h3><dl class="kv"><dt>Agent's stated purpose</dt><dd>${esc(r.proposed.agentPurpose)}</dd>
        <dt>Signed by</dt><dd>${esc(req.issuer || req.error)}</dd><dt>Description</dt><dd>${esc(req.description)}</dd><dt>Options</dt><dd>${options}</dd></dl></div></li>
      <li><div><h3>Policy decision</h3>${
        r.decisions.length
          ? r.decisions
              .map(
                (d) =>
                  `<p><b>${esc(d.outcome)}</b> by <b>${esc(d.rule.id)}</b> (${esc(ruleLabel(d.rule.id))})${d.afterApproval ? ", after approval" : ""}</p>${
                    d.checks.length ? `<ul class="checks">${d.checks.map((ch) => checkRow(ch, d.rule.id)).join("")}</ul>` : `<p class="muted">${esc(d.rule.detail)}</p>`
                  }`,
              )
              .join("")
          : `<p class="muted">No decision recorded.</p>`
      }${r.approval ? `<p>Human approval: <b>${r.approval.approved ? "approved" : "declined"}</b> by ${esc(r.approval.by)}</p>` : ""}</div></li>
      <li><div><h3>Settlement and ACK receipt</h3>${
        r.settlement
          ? `<dl class="kv"><dt>Ledger transaction</dt><dd>${esc(r.settlement.tx.txId)}: ${money(r.settlement.tx.amount)} to ${esc(r.settlement.tx.to)}</dd>
             <dt>PaymentReceiptCredential</dt><dd>${r.receipt ? yes(r.receipt.verifiedNow.ok) + " with verifyPaymentReceipt" : "missing"}</dd></dl>`
          : `<p class="muted">No money moved.</p>`
      }</div></li>
      <li><div><h3>Log integrity</h3><dl class="kv"><dt>Whole log (${r.chain.entries} entries)</dt><dd>${yes(r.chain.ok)}${r.chain.ok ? "" : ` (first bad entry ${esc(r.chain.firstBadSeq)})`}</dd>
        <dt>Entries in this replay</dt><dd>${yes(r.chain.relatedEntriesIntact)} (${r.chain.relatedSeqs.length} entries)</dd>
        <dt>Signer</dt><dd>${r.chain.pinned ? `<span class="ok">${esc(r.signerSource)}</span>` : `<span class="bad">${esc(r.signerSource)}</span>. Identity and receipt checks rely on the log's own genesis entry.`}</dd></dl></div></li>
    </ol>`
}

// ---------- tamper ----------
async function tamper() {
  const out = $("#tamper-out")
  const btn = $("#tamper-btn")
  btn.disabled = true
  try {
    const r = await api(`/api/tamper-demo?log=${encodeURIComponent(state.log)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    const probs = r.after.problems.slice(0, 4).map((p) => `<li>entry ${esc(p.seq)}: ${esc(p.kind)}, ${esc(p.detail)}</li>`).join("")
    out.innerHTML = `<div class="result"><b>${r.after.ok ? "Not detected" : `Detected. First bad entry: ${esc(r.after.firstBadSeq)}`}</b>.
      Changed entry ${esc(r.tamperedSeq)} in a copy (${esc(r.change)}). The original log still verifies: ${r.before.ok ? "yes" : "no"}.<ul>${probs}</ul></div>`
  } catch (e) {
    out.innerHTML = `<div class="result">${esc(e.message)}</div>`
  } finally {
    btn.disabled = false
  }
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
const replayLink = (id, text) => `<button class="link" type="button" data-replay="${esc(id)}">${esc(text)}</button>`
const runAndWait = (scenarioId) =>
  api("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenarioId, mode: "guarded", wait: true }) })

async function guidedDemo() {
  const btn = $("#guided-btn")
  btn.disabled = true
  for (const n of [1, 2, 3]) setStep(n, "", "", null)
  try {
    if (state.liveLog && state.log !== state.liveLog) {
      state.log = state.liveLog
      $("#log").value = state.liveLog
    }
    setStep(1, "running", "The agent is working on it", null)
    const a = await runAndWait("B-01")
    const paid = a.attempts.find((x) => x.status === "paid")
    if (paid) setStep(1, "good", `Paid ${esc(paid.amount)}. Every policy check passed and the ACK receipt verified. ${replayLink(paid.attemptId, "Open the replay")}`, "done-good")
    else setStep(1, "warn", `The agent did not complete the purchase this time${a.error ? ` (${esc(a.error)})` : ""}.`, null)

    setStep(2, "running", "The agent is reading its inbox", null)
    const b = await runAndWait("FI-01")
    const blocked = b.attempts.find((x) => x.status === "blocked" || x.status === "escalated_denied")
    if (blocked) {
      setStep(2, "stop", `The agent tried to pay it. Blocked: ${esc(ruleLabel(blocked.rule))} (${esc(blocked.rule)}). No money moved to the attacker. ${replayLink(blocked.attemptId, "Open the replay")}`, "done-stop")
    } else {
      setStep(2, "warn", "The model ignored the planted invoice this time, so the guard had nothing to stop. Run the demo again to retry.", null)
    }

    setStep(3, "running", "Editing a copy of the log and verifying it", null)
    const q = blocked ? `&attemptId=${encodeURIComponent(blocked.attemptId)}` : ""
    const t = await api(`/api/tamper-demo?log=${encodeURIComponent(state.log)}${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    setStep(
      3,
      t.after.ok ? "warn" : "stop",
      t.after.ok
        ? "The edit was not detected."
        : `Detected at entry ${esc(t.after.firstBadSeq)}: ${esc(t.after.problems[0]?.detail || "")}. The original log still verifies.`,
      t.after.ok ? null : "done-stop",
    )
    await Promise.all([loadAttempts(), checkIntegrity()])
  } catch (e) {
    $("#guided-info").textContent = e.message
  } finally {
    btn.disabled = false
    btn.textContent = "Run it again"
  }
}

async function loadCatalog() {
  state.catalog = await api("/api/catalog")
  state.labels = state.catalog.categories
}

// ---------- live runs and approvals ----------
async function loadLive() {
  const { canRun, scenarios, info } = await api("/api/scenarios")
  if (!canRun) return
  $("#live").hidden = false
  $("#guided").hidden = false
  $("#live-info").textContent = info.model ? `Agent model: ${info.model}` : ""
  $("#guided-info").textContent = `Runs live in the sandbox with ${info.model || "the configured agent"}. No real money moves.`
  $("#scenario").innerHTML = scenarios
    .map((s) => `<option value="${esc(s.id)}">${esc(s.id)}: ${esc(s.title)}</option>`)
    .join("")
}

async function loadApprovals() {
  if ($("#live").hidden) return
  const list = await api("/api/approvals")
  $("#approvals").innerHTML = list
    .map(
      (a) => `<div class="approval"><div><b>Approval needed: ${money(a.amount)} to ${esc(a.merchant)} for ${esc(a.endpoint)}</b>
        <p class="muted">${esc(a.episodeId)}. ${esc(a.rule.detail)}</p></div>
        <div class="actions"><button data-approve="${esc(a.id)}">Approve payment</button><button class="deny" data-deny="${esc(a.id)}">Decline</button></div></div>`,
    )
    .join("")
}

// ---------- wiring ----------
$("#run").addEventListener("change", renderRun)
$("#log").addEventListener("change", async (e) => {
  state.log = e.target.value
  state.selected = null
  await Promise.all([loadAttempts(), checkIntegrity()])
})
document.querySelector(".filters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]")
  if (!b) return
  state.filter = b.dataset.filter
  document.querySelectorAll(".filters .chip").forEach((c) => c.classList.toggle("on", c === b))
  renderAttempts()
})
$("#attempts").addEventListener("click", (e) => {
  const li = e.target.closest("[data-id]")
  if (li) replay(li.dataset.id)
})
$("#attempts").addEventListener("keydown", (e) => {
  const li = e.target.closest("[data-id]")
  if (li && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault()
    replay(li.dataset.id)
  }
})
$("#tamper-btn").addEventListener("click", tamper)
$("#guided-btn").addEventListener("click", guidedDemo)
$("#guided").addEventListener("click", (e) => {
  const id = e.target.dataset?.replay
  if (!id) return
  replay(id)
  document.querySelector(".workbench").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" })
})
$("#run-form").addEventListener("submit", async (e) => {
  e.preventDefault()
  const mode = new FormData(e.target).get("mode")
  const scenarioId = $("#scenario").value
  $("#run-status").textContent = `Running ${scenarioId} with the ${mode} agent`
  try {
    const r = await api("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenarioId, mode }) })
    $("#run-status").textContent = `Started ${r.episodeId}. Payment attempts appear in the timeline.`
  } catch (err) {
    $("#run-status").textContent = err.message
  }
})
$("#approvals").addEventListener("click", async (e) => {
  const id = e.target.dataset.approve || e.target.dataset.deny
  if (!id) return
  await api(`/api/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved: !!e.target.dataset.approve }),
  })
  loadApprovals()
})

function connectEvents() {
  const es = new EventSource("/api/events")
  let timer
  es.addEventListener("entry", () => {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      if (state.log === state.liveLog) await Promise.all([loadAttempts(), checkIntegrity()])
      loadApprovals()
    }, 250)
  })
}

await loadCatalog().catch(() => {})
await loadRuns(false).catch((e) => ($("#run-meta").textContent = e.message))
await loadLogs()
await Promise.all([loadAttempts(), checkIntegrity(), loadLive()])
loadApprovals()
connectEvents()
setInterval(() => loadRuns(true).catch(() => {}), 8000)
setInterval(() => loadApprovals().catch(() => {}), 3000)
