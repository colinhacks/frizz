import assert from "node:assert/strict"
import test from "node:test"
import { parseLaunchPrefix, type Settings } from "@frizz/shared"
import { launchPrefixPreview as preview, withLaunchPrefix } from "./launchPrefixField.ts"

const base = { permissionMode: "auto", notifications: true } as unknown as Settings

test("setting one runtime's prefix keeps the other's and every other setting", () => {
  const withCodex = withLaunchPrefix(base, "codex", "nice -n 10")
  const both = withLaunchPrefix(withCodex, "claude", "op run --env-file .env --")
  assert.deepEqual(both, { ...base, launchPrefix: { codex: "nice -n 10", claude: "op run --env-file .env --" } })
  // The prefix is stored as typed, not re-joined from its words: reopening shows the same text.
  assert.equal(withLaunchPrefix(base, "claude", "op  run '--x y' ").launchPrefix?.claude, "op  run '--x y' ")
})

test("a blank prefix is dropped rather than stored as an empty string", () => {
  const both = { ...base, launchPrefix: { claude: "op run --", codex: "nice" } }
  assert.deepEqual(withLaunchPrefix(both, "claude", "   "), { ...base, launchPrefix: { codex: "nice" } })
  // The last one emptied takes the object with it.
  assert.deepEqual(withLaunchPrefix({ ...base, launchPrefix: { claude: "op run --" } }, "claude", ""), base)
  assert.equal("launchPrefix" in withLaunchPrefix(base, "codex", ""), false)
})

test("the preview shows the words the parser split, then the runtime's own command", () => {
  // The tail is glued with no-break spaces so it wraps as one piece; compare with plain spaces.
  const launchPrefixPreview = (...args: Parameters<typeof preview>) => preview(...args).replaceAll("\u00a0", " ")
  assert.equal(preview(["op"], "codex"), "op codex\u00a0app-server\u00a0…")
  const argv = (text: string) => {
    const parsed = parseLaunchPrefix(text)
    assert.ok(parsed.ok, text)
    return parsed.argv
  }
  assert.equal(launchPrefixPreview(argv("op run --env-file .env --"), "claude"), "op run --env-file .env -- claude …")
  assert.equal(launchPrefixPreview(argv("op run --"), "codex"), "op run -- codex app-server …")
  // A quoted word with a space in it stays one word, so the preview quotes it back.
  assert.equal(
    launchPrefixPreview(argv(`sh -c 'exec "$@"' sh`), "claude"),
    `sh -c 'exec "$@"' sh claude …`,
  )
  assert.equal(launchPrefixPreview(argv(`env "A=it's"`), "claude"), `env 'A=it'\\''s' claude …`)
  // `~` stays as typed: the browser knows no home, and the server expands it.
  assert.equal(launchPrefixPreview(argv("~/bin/wrap"), "claude"), "~/bin/wrap claude …")
})
