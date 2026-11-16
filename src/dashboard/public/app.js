// ACK Guard dashboard. Vanilla JS, no build step. All untrusted text (agent
// output, attacker content) is escaped before it reaches the DOM.

const $ = (s) => document.querySelector(s)
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch])
const pct = (x) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`
const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`
const api = async (path, init) => {
  const r = await fetch(path, init)
  const j = await r.json()
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j
}

const state = { runs: [], labels: {}, run: null, log: null, attempts: [], filter: "all", selected: null, liveLog: null }

// ---------- scoreboard ----------
async function loadRuns(keepSelection = true) {
  const { runs, categoryLabels } = await api("/api/runs")
  state.labels = categoryLabels
  state.runs = runs.sort((a, b) => b.path.localeCompare(a.path))
  const sel = $("#run")
  const prev = keepSelection ? sel.value : ""
  sel.innerHTML = state.runs.map((r) => `<option value="${esc(r.path)}">${esc(r.path.replace(/^results\//, ""))}</option>`).join("")
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
  const progress = total && s.episodes < total ? `, recording: ${s.episodes} of ${total} episodes so far` : ""
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
      const rules = Object.entries(rulesByCat[k] || {}).sort((a, b) => b[1] - a[1]).map(([r]) => r).slice(0, 3).join(", ")
      const note = rules || (v.guarded.n ? "no payment was attempted" : "not run yet")
      return `<tr><th scope="row">${esc(v.label)}</th><td>${bar("naive", v.naive)}</td><td>${bar("guarded", v.guarded)}</td><td class="rules">${esc(note)}</td></tr>`
    })
    .join("")
  $("#scenarios").innerHTML = s.scenarios
    .map((sc) => {
      const benign = sc.category === "benign"
      const cell = (x) => (benign ? `completed ${x.completed}/${x.n}` : `${x.successes}/${x.n} succeeded`)
      const rules = Object.entries(sc.guarded.rules || {}).map(([r, n]) => `${r} x${n}`).join(", ")
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
    el.className = `integrity ${v.ok ? "ok" : "bad"}`
    el.textContent = v.ok
      ? `Audit log verified: ${v.entries} signed entries`
      : `Tampering detected at entry ${v.firstBadSeq ?? "?"}`
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
  const label = (p) => (p === live ? "Live demo log" : p.replace(/^results\//, "").replace(/\/audit\.jsonl$/, ""))
  sel.innerHTML = logs.map((p) => `<option value="${esc(p)}">${esc(label(p))}</option>`).join("")
  if (!state.log || !logs.includes(state.log)) state.log = live && logs.includes(live) ? live : logs[0]
  if (state.log) sel.value = state.log
}

function outcomeTag(a) {
  if (a.outcome === "paid") return a.mode === "naive" ? ["paid-naive", "Paid, no guard"] : ["paid", "Paid"]
  if (a.outcome === "needs_approval") return ["held", "Human declined"]
  if (a.outcome === "awaiting_approval") return ["held", "Waiting for a human"]
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
        const rule = a.mode === "guarded" ? a.rule : "no policy"
        return `<li class="attempt" tabindex="0" data-id="${esc(a.attemptId)}" aria-current="${a.attemptId === state.selected}">
          <span class="id">${esc(a.attemptId)}</span><span class="tag ${cls}">${esc(text)}</span>
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
      : r.finalOutcome === "needs_approval"
        ? `Held for a human, who declined. Rule: ${last?.rule?.id}`
        : `Blocked by ${last?.rule?.id}: ${last?.rule?.detail}`
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
    <h2>${esc(r.attemptId)}</h2>
    <p class="muted">${esc(r.mode)} agent${t.scenarioId ? `, scenario ${esc(t.scenarioId)}` : ""}${t.model ? `, model ${esc(t.model)}` : ""}</p>
    <p class="verdict ${verdictCls}">${esc(verdictText)}</p>
    <ol class="steps">
      <li><div><h3>Task, as set by the owner</h3><p class="quote">${esc(task.prompt)}</p>
        <dl class="kv"><dt>Declared needs</dt><dd>${esc((task.needs || []).join(", ") || "none")}</dd><dt>Budget</dt><dd>${money(task.budget)}</dd></dl></div></li>
      <li><div><h3>Identity (ACK-ID)</h3><dl class="kv"><dt>Agent</dt><dd>${esc(r.identity.agentDid)}</dd><dt>Owner</dt><dd>${esc(r.identity.ownerDid)}</dd>
        <dt>ControllerCredential</dt><dd>${yes(r.identity.controllerCredentialValid)}</dd></dl></div></li>
      <li><div><h3>What the agent did first</h3>${reasoning}</div></li>
      <li><div><h3>The payment it asked for</h3><dl class="kv"><dt>Agent's stated purpose</dt><dd>${esc(r.proposed.agentPurpose)}</dd>
        <dt>Signed by</dt><dd>${esc(req.issuer || req.error)}</dd><dt>Description</dt><dd>${esc(req.description)}</dd><dt>Options</dt><dd>${options}</dd></dl></div></li>
      <li><div><h3>Policy decision</h3>${
        r.decisions.length
          ? r.decisions
              .map(
                (d) =>
                  `<p><b>${esc(d.outcome)}</b> by <b>${esc(d.rule.id)}</b>${d.afterApproval ? " (after approval)" : ""}</p>${
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
        <dt>Entries in this replay</dt><dd>${yes(r.chain.relatedEntriesIntact)} (${r.chain.relatedSeqs.length} entries)</dd></dl></div></li>
    </ol>`
}

// ---------- tamper ----------
async function tamper() {
  const out = $("#tamper-out")
  const btn = $("#tamper-btn")
  btn.disabled = true
  try {
    const r = await api(`/api/tamper-demo?log=${encodeURIComponent(state.log)}`, { method: "POST" })
    const probs = r.after.problems.slice(0, 4).map((p) => `<li>entry ${esc(p.seq)}: ${esc(p.kind)}, ${esc(p.detail)}</li>`).join("")
    out.innerHTML = `<div class="result"><b>${r.after.ok ? "Not detected" : `Detected. First bad entry: ${esc(r.after.firstBadSeq)}`}</b>.
      Changed entry ${esc(r.tamperedSeq)} in a copy (${esc(r.change)}). The original log still verifies: ${r.before.ok ? "yes" : "no"}.<ul>${probs}</ul></div>`
  } catch (e) {
    out.innerHTML = `<div class="result">${esc(e.message)}</div>`
  } finally {
    btn.disabled = false
  }
}

// ---------- live runs and approvals ----------
async function loadLive() {
  const { canRun, scenarios, info } = await api("/api/scenarios")
  if (!canRun) return
  $("#live").hidden = false
  $("#live-info").textContent = info.model ? `Agent model: ${info.model}` : ""
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

await loadRuns(false).catch((e) => ($("#run-meta").textContent = e.message))
await loadLogs()
await Promise.all([loadAttempts(), checkIntegrity(), loadLive()])
loadApprovals()
connectEvents()
setInterval(() => loadRuns(true).catch(() => {}), 8000)
setInterval(() => loadApprovals().catch(() => {}), 3000)
