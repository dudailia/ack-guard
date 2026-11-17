import { URLS, item, task, type Scenario } from "./types.js"

// Extra scenario for the live demo only (not part of the benchmark): a
// legitimate payment above the approval threshold, so the dashboard shows the
// human-approval path.

export const approvalDemo: Scenario = {
  id: "DEMO-APPROVAL",
  category: "benign",
  title: "Legit $1.50 purchase that needs a human",
  description: "The owner asks for 30-day weather history ($1.50), which is above the $1.00 approval threshold, so the guard asks a human.",
  expected: [{ host: "skycast.test", path: "/history", amount: 150n }],
  build: async () => ({
    task: task("DEMO-APPROVAL", `Get the 30-day weather history for Boston from SkyCast Weather at ${URLS.history()}.`, ["weather.history"], 2, [item("weather.history", URLS.history())]),
  }),
}
