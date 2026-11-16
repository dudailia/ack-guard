// Policy page: renders the active policy in plain language, diffs a proposed
// change against a signed audit log, and approves it.

const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
async function api(path, init) {
  const r = await fetch(path, init)
  const j = await r.json()
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j
}
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

let state = { policy: null, diffId: null }

function render(p) {
  const d = p.doc
  const l = d.limits
  $("#policy-meta").textContent = `${d.name}, version ${p.version}. ${p.source === "approved" ? `Approved ${new Date(p.approvedAt).toLocaleString()}.` : "The repository's policy.yaml (no approved changes yet)."}`
  const rule = (id) => d.rules.find((r) => r.id === id)
  const on = (id) => rule(id)?.enabled !== false
  const limits = [
    [`$${l.per_payment_cap}`, "the most any single payment can be", on("PER_PAYMENT_CAP")],
    [`$${l.approval_threshold}`, "payments above this wait for you to approve them", on("HUMAN_APPROVAL")],
    [`$${l.daily_cap}`, "the most the agent can spend in any 24 hours", on("DAILY_CAP")],
    [`${l.duplicate_window_hours} hours`, "nothing is bought twice for one task in this window, unless the task asks for it twice", on("DUPLICATE_CHARGE")],
  ]
  $("#limits").innerHTML = limits.map(([v, t, enabled]) => `<li><b>${esc(v)}</b>${esc(t)}${enabled ? "" : ` <span class="badge off">check switched off</span>`}</li>`).join("")
  $("#merchants").innerHTML = d.merchants
    .map(
      (m) => `<div class="merchant"><h3>${esc(m.name)}</h3><p class="muted">${m.hosts.map(esc).join(", ")}</p><ul>${m.sells
        .map((e) => `<li>${esc(e.description || e.capability)}: <b>$${esc(e.price)}</b> <span class="muted">(${esc(e.capability)})</span></li>`)
        .join("")}</ul></div>`,
    )
    .join("")
  $("#rules").innerHTML = d.rules
    .map((r) => {
      const badge = r.enabled === false ? `<span class="badge off">Switched off</span>` : r.on_fail === "escalate" ? `<span class="badge ask">Asks you</span>` : `<span class="badge deny">Refuses</span>`
      return `<li><div><p>${esc(r.plain)}</p><p class="id">${esc(r.id)}: ${esc(r.title)}</p></div>${badge}</li>`
    })
    .join("")
  $("#history").innerHTML = p.history.length
    ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Change</th><th>Checked against</th><th>Approved by</th></tr></thead><tbody>${p.history
        .map(
          (h) => `<tr><td>${esc(new Date(h.ts).toLocaleString())}</td><td>${esc(h.from.version)} to ${esc(h.to.version)}<br><span class="muted">${(h.changes || []).map(esc).join("<br>")}</span></td>
            <td>${esc(h.diff.decisionsReplayed)} past decisions in ${esc(h.diff.log)}</td><td class="muted">${esc(h.by)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="muted">None yet. The live guard runs the repository's policy.yaml.</p>`
}

const changeWord = { "now allowed": "now allowed", "now blocked": "now refused", "now escalated": "now held for you", "different rule": "different reason" }
const word = (o) => (o === "allow" ? "allowed" : o === "deny" ? "refused" : "held for you")

async function diff() {
  const out = $("#diff")
  out.innerHTML = `<p class="muted">Verifying the log and replaying every past decision under the proposed policy</p>`
  state.diffId = null
  let d
  try {
    d = await post("/api/policy/diff", { yaml: $("#yaml").value, log: $("#log").value })
  } catch (e) {
    out.innerHTML = `<p class="err">${esc(e.message)}</p>`
    return
  }
  state.diffId = d.id
  const rows = d.changes
    .slice(0, 60)
    .map(
      (c) => `<tr class="${c.change.replace(" ", "-")}"><td>${esc(changeWord[c.change] || c.change)}</td><td>${esc(c.scenarioId || c.episodeId)}<br><span class="muted">${esc(c.attemptId)}</span></td>
        <td>${esc(c.merchant || "")} ${esc(c.endpoint || "")}</td><td>${esc(c.amount || "")}</td>
        <td>${esc(word(c.current.outcome))} <span class="muted">(${esc(c.current.rule)})</span></td><td>${esc(word(c.proposed.outcome))} <span class="muted">(${esc(c.proposed.rule)})</span>${c.afterEarlierChange ? `<br><span class="muted">after an earlier change in this run</span>` : ""}</td></tr>`,
    )
    .join("")
  out.innerHTML = `
    <h3>What the change says</h3>
    <ul>${(d.policyChanges.length ? d.policyChanges : ["No changes to limits, merchants or rules."]).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    <h3>What it would have done to past payments</h3>
    <p>${d.logVerified ? `<span class="ok">The log verifies</span> (${d.logEntries} signed entries).` : `<span class="err">The log does not verify, so nothing was replayed.</span>`}
      ${d.decisionsReplayed} past decisions replayed from <code>${esc(d.log)}</code>; ${d.unchanged} unchanged.</p>
    <div class="counts"><span><b>${d.counts["now allowed"]}</b>now allowed</span><span><b>${d.counts["now blocked"]}</b>now refused</span><span><b>${d.counts["now escalated"]}</b>now held for you</span><span><b>${d.counts["different rule"]}</b>same outcome, different reason</span></div>
    ${rows ? `<div class="table-wrap"><table><thead><tr><th>Change</th><th>Task run</th><th>Merchant</th><th>Amount</th><th>Was</th><th>Would be</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
    ${d.changes.length > 60 ? `<p class="muted">${d.changes.length - 60} more not shown.</p>` : ""}
    ${d.notes.map((n) => `<p class="muted">${esc(n)}</p>`).join("")}
    ${d.logVerified && d.from.hash !== d.to.hash ? `<div class="row"><button id="approve-btn" type="button">Approve and sign this change</button><span class="muted">Signs with the owner's key and records the approval in the signed policy log.</span></div>` : ""}`
  $("#approve-btn")?.addEventListener("click", approve)
}

async function approve() {
  const btn = $("#approve-btn")
  btn.disabled = true
  try {
    const r = await post("/api/policy/approve", { id: state.diffId })
    btn.insertAdjacentHTML("afterend", `<span class="ok">Approved. Version ${esc(r.version)} is now active (policy log entry ${esc(r.seq)}).</span>`)
    await load()
  } catch (e) {
    btn.insertAdjacentHTML("afterend", `<span class="err">${esc(e.message)}</span>`)
    btn.disabled = false
  }
}

async function load() {
  const p = await api("/api/policy")
  state.policy = p
  render(p)
  if (!$("#yaml").value) $("#yaml").value = p.text
}

async function main() {
  await load()
  const { live, logs, superseded = [], sizes = {} } = await api("/api/logs")
  // Current benchmark logs first (they hold the most past decisions), superseded ones last.
  const sup = new Set(superseded)
  const results = logs.filter((l) => l.startsWith("results/") && !sup.has(l)).sort((a, b) => (sizes[b] ?? 0) - (sizes[a] ?? 0))
  const ordered = [...results, ...logs.filter((l) => !l.startsWith("results/")), ...logs.filter((l) => sup.has(l))]
  const label = (l) => (l === live ? `${l} (this session)` : sup.has(l) ? `${l} (superseded run)` : l)
  $("#log").innerHTML = ordered.map((l) => `<option value="${esc(l)}">${esc(label(l))}</option>`).join("")
  $("#diff-btn").addEventListener("click", diff)
  $("#example-btn").addEventListener("click", () => {
    $("#yaml").value = state.policy.text.replace(/approval_threshold: "[^"]*"/, 'approval_threshold: "0.40"')
    diff()
  })
}
main()
