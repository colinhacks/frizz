import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SUPERVISOR_STATUS_KEY } from "../api/supervisorStatus.ts"
import { MobileUpdateRow } from "./SettingsDrawer.tsx"

// The phone Settings page's "Update Frizz" row, rendered over a seeded status query the way the page
// mounts it. The board gear's dot is the desktop badge rule (RestartFrizzButton.test.ts,
// showsUpdateBadge); inside Settings the row offers, and dots, any OBSERVED newer version.
const render = (status: Record<string, unknown> | null) => {
  const client = new QueryClient()
  client.setQueryData(SUPERVISOR_STATUS_KEY, status && { protocol: 1, state: "ready", requestedAt: Date.now(), ...status })
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MobileUpdateRow)))
}
const row = (html: string) => html.match(/<button[^>]*data-mobile-update-row[^>]*>/)?.[0] ?? ""

test("a newer release line or patch: a live row with the version step and a dot on the label", () => {
  for (const [updateVersion, step] of [["0.14.0", "0.13.8 → 0.14.0"], ["0.13.9", "0.13.8 → 0.13.9"]]) {
    const html = render({ updateRestart: true, updateAvailable: true, version: "0.13.8", updateVersion })
    assert.match(html, />Update Frizz</)
    assert.match(html, new RegExp(`data-mobile-update-step[^>]*>${step}<`))
    assert.match(html, /data-mobile-update-row-notification/)
    assert.doesNotMatch(row(html), /disabled=""/)
    // It sits under its own section label, in the page's row style.
    assert.match(html, />Version</)
    assert.match(row(html), /min-h-\[52px\]/)
    assert.match(row(html), /px-\[18px\]/)
  }
})

test("frizz-dev and a registry probe that has not answered: live, but no step and no dot", () => {
  for (const status of [{ updateRestart: true, dev: true }, { updateRestart: true, version: "0.13.8" }]) {
    const html = render(status)
    assert.match(html, />Update Frizz</)
    assert.doesNotMatch(row(html), /disabled=""/)
    assert.doesNotMatch(html, /data-mobile-update-step|data-mobile-update-row-notification/)
  }
})

test("up to date: a muted, inert row that offers no verb", () => {
  for (const status of [{ updateRestart: true, updateAvailable: false, version: "0.14.0" }, {}]) {
    const html = render(status)
    assert.match(html, />Frizz is up to date</)
    assert.match(row(html), /disabled=""/)
    assert.doesNotMatch(html, /Update Frizz|Restart Frizz|data-mobile-update-row-notification|data-mobile-update-step/)
  }
})

test("an update the launcher went back from: an inert row that says so, with the step it undid", () => {
  const html = render({ updateRestart: true, updateAvailable: false, version: "0.14.0", rejectedUpdate: "0.14.1" })
  assert.match(html, />Update undone</)
  assert.match(html, /data-mobile-update-undone[^>]*>0\.14\.1 → 0\.14\.0</)
  assert.match(row(html), /disabled=""/)
  assert.doesNotMatch(html, /up to date|Update Frizz|Restart Frizz|data-mobile-update-row-notification|data-mobile-update-step/)
  // A newer version than the one it went back from is offered as any other.
  const offered = render({ updateRestart: true, updateAvailable: true, version: "0.14.0", updateVersion: "0.14.2", rejectedUpdate: "0.14.1" })
  assert.match(offered, />Update Frizz</)
  assert.match(offered, /data-mobile-update-step[^>]*>0\.14\.0 → 0\.14\.2</)
  assert.doesNotMatch(offered, /undone/)
})

test("nothing before a supervisor has answered", () => {
  assert.equal(render(null), "")
})
