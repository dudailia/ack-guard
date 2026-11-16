// Records the dashboard's guided demo with Playwright and converts it with ffmpeg.
//   pnpm record-demo [--model qwen3:8b|scripted]
// Outputs docs/demo.mp4 (gitignored) and docs/demo.gif (for the README).
// Requires: `npx playwright install chromium` and ffmpeg on PATH.

import { spawn, execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"
import { chromium } from "playwright"

const args = process.argv.slice(2)
const modelIdx = args.indexOf("--model")
const model = modelIdx >= 0 ? args[modelIdx + 1] : undefined
const PORT = 4310
const URL = `http://localhost:${PORT}`
const docs = join(process.cwd(), "docs")
const videoDir = join(process.cwd(), ".data", "video")
mkdirSync(docs, { recursive: true })
mkdirSync(videoDir, { recursive: true })

const server = spawn("npx", ["tsx", "src/cli/demo.ts", "--port", String(PORT), ...(model ? ["--model", model] : [])], {
  stdio: ["ignore", "pipe", "inherit"],
})
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("demo server did not start")), 120_000)
  server.stdout!.on("data", (d: Buffer) => {
    process.stdout.write(d)
    if (d.toString().includes("dashboard")) {
      clearTimeout(t)
      resolve()
    }
  })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 760 } } })
const page = await context.newPage()
try {
  await page.goto(URL)
  await page.waitForSelector("#guided:not([hidden])")
  await sleep(5000)
  await page.click("#guided-btn")
  for (const n of [1, 2, 3]) {
    await page.waitForFunction((k) => {
      const el = document.querySelector(`#g${k}`)
      return !!el && el.textContent!.length > 0 && !el.classList.contains("running")
    }, n, { timeout: 180_000 })
    await sleep(n === 3 ? 6000 : 4500)
  }
  // Open the replay of the blocked payment to show the rule and checks.
  const link = page.locator("#g2 [data-replay]")
  if (await link.count()) {
    await link.click()
    await sleep(3500)
    await page.mouse.wheel(0, 450)
    await sleep(3500)
    await page.mouse.wheel(0, 450)
    await sleep(3500)
  }
  // The scoreboard from the recorded benchmark.
  await page.locator(".score").scrollIntoViewIfNeeded()
  await page.evaluate(() => document.querySelector(".score")!.scrollIntoView({ block: "start" }))
  await sleep(5000)
  await page.mouse.wheel(0, 400)
  await sleep(4000)
  // A still of the dashboard after the guided demo, for the README.
  await page.evaluate(() => window.scrollTo(0, 0))
  await sleep(800)
  await page.screenshot({ path: join(docs, "dashboard.png"), fullPage: true, clip: { x: 0, y: 0, width: 1280, height: 1500 } })
  await sleep(1500)

  // The Policy page: the policy in plain language, then a proposed change diffed against the recorded benchmark.
  await page.goto(`${URL}/policy`)
  await page.waitForSelector("#rules li")
  await sleep(4000)
  await page.evaluate(() => document.querySelector("#rules-title")!.scrollIntoView({ block: "start" }))
  await sleep(4000)
  await page.evaluate(() => document.querySelector("#propose-title")!.scrollIntoView({ block: "start" }))
  await sleep(1500)
  await page.click("#example-btn")
  await page.waitForSelector("#approve-btn", { timeout: 120_000 })
  await page.evaluate(() => document.querySelector("#diff h3")!.scrollIntoView({ block: "start" }))
  await sleep(6000)
  await page.screenshot({ path: join(docs, "policy-diff.png") })
  await page.mouse.wheel(0, 350)
  await sleep(3500)
} finally {
  await context.close()
  await browser.close()
  server.kill("SIGINT")
}

const webm = readdirSync(videoDir)
  .filter((f) => f.endsWith(".webm"))
  .map((f) => join(videoDir, f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
if (!webm) throw new Error("no video recorded")
const raw = join(videoDir, "demo.webm")
renameSync(webm, raw)
const mp4 = join(docs, "demo.mp4")
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-movflags", "+faststart", mp4])
const gif = join(docs, "demo.gif")
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", "-i", raw,
  "-vf", "setpts=0.5*PTS,fps=8,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
  gif,
])
const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4]).toString().trim()
console.log(`\nWrote ${mp4} (${Number(dur).toFixed(0)}s, ${(statSync(mp4).size / 1e6).toFixed(1)} MB) and ${gif} (${(statSync(gif).size / 1e6).toFixed(1)} MB)`)
