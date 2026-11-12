import assert from "node:assert/strict"
import test from "node:test"
import { headersForBoard, headersForVisitor, ISSUED_HEADER, keyTagOf, OWNER_HEADER } from "./visitor-headers.ts"

const ADA = keyTagOf("AdaAdaAdaAdaAdaAdaAdaAdaAdaAdaAdaAdaAdaAdaA")
const EVE = keyTagOf("EveEveEveEveEveEveEveEveEveEveEveEveEveEveE")

const get = (headers: Array<[string, string]>, name: string) => headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v)

test("every answer is revalidated before use, unless the board said not to store it at all", () => {
  // The previous holder's year-long `immutable` asset is what ran beside the next holder's session.
  assert.deepEqual(get(headersForVisitor([["Cache-Control", "public, max-age=31536000, immutable"]], ADA), "cache-control"), ["no-cache"])
  assert.deepEqual(get(headersForVisitor([["content-type", "text/html"]], ADA), "cache-control"), ["no-cache"], "no header is no licence to cache by heuristic")
  assert.deepEqual(get(headersForVisitor([["cache-control", "no-store"]], ADA), "cache-control"), ["no-store"])
  assert.deepEqual(get(headersForVisitor([["cache-control", "private"], ["cache-control", "no-store, max-age=0"]], ADA), "cache-control"), ["private, no-store, max-age=0"])
  const visitor = headersForVisitor([["expires", "Thu, 01 Jan 2099 00:00:00 GMT"], ["last-modified", "Thu, 01 Jan 2099 00:00:00 GMT"], ["service-worker-allowed", "/"]], ADA)
  assert.deepEqual(get(visitor, "expires").concat(get(visitor, "last-modified"), get(visitor, "service-worker-allowed")), [])
})

test("a validator belongs to the key that served it, so a copy cached from another key is answered in full", () => {
  assert.deepEqual(get(headersForVisitor([["ETag", '"5a3-18c"']], ADA), "etag"), [`"${ADA}.5a3-18c"`])
  assert.deepEqual(get(headersForVisitor([["etag", 'W/"5a3-18c"']], ADA), "etag"), [`W/"${ADA}.5a3-18c"`])
  assert.deepEqual(get(headersForVisitor([["etag", "not a tag"]], ADA), "etag"), [])

  // Ada's own copy revalidates against her board, which can answer 304.
  assert.deepEqual(get(headersForBoard([["If-None-Match", `"${ADA}.5a3-18c"`]], ADA), "if-none-match"), ['"5a3-18c"'])
  assert.deepEqual(get(headersForBoard([["if-none-match", `W/"${ADA}.5a3-18c", "${EVE}.5a3-18c"`]], ADA), "if-none-match"), ['W/"5a3-18c"'])
  // Eve guessed Ada's ETag exactly (size and mtime are public), but her copy carries her own key's tag.
  assert.deepEqual(get(headersForBoard([["if-none-match", `"${EVE}.5a3-18c"`]], ADA), "if-none-match"), [], "another key's copy is never revalidated")
  assert.deepEqual(get(headersForBoard([["if-none-match", '"5a3-18c"']], ADA), "if-none-match"), [], "an untagged validator is no one's")
  assert.deepEqual(get(headersForBoard([["if-none-match", "*"]], ADA), "if-none-match"), ["*"])
  for (const dated of ["if-modified-since", "If-Unmodified-Since", "if-range"]) {
    assert.deepEqual(get(headersForBoard([[dated, "Thu, 01 Jan 2099 00:00:00 GMT"]], ADA), dated.toLowerCase()), [], dated)
  }
})

test("nothing a board sends reaches past its own name", () => {
  // frizz.sh is not on the Public Suffix List, so a Domain=frizz.sh cookie rode to every board.
  const cookies = get(
    headersForVisitor(
      [
        ["set-cookie", "bomb=x; Domain=frizz.sh; Path=/; Max-Age=31536000"],
        ["Set-Cookie", "__Host-frizz_session=abc; Path=/; Secure; HttpOnly; SameSite=Lax"],
        ["set-cookie", "a=b;domain=.frizz.sh;Secure"],
      ],
      ADA
    ),
    "set-cookie"
  )
  assert.deepEqual(cookies, ["bomb=x; Path=/; Max-Age=31536000", "__Host-frizz_session=abc; Path=/; Secure; HttpOnly; SameSite=Lax", "a=b;Secure"])
  // Clear-Site-Data for cookies clears the whole registrable domain: every board's sessions.
  assert.deepEqual(get(headersForVisitor([["clear-site-data", '"cookies"']], ADA), "clear-site-data"), [])
  assert.deepEqual(get(headersForVisitor([["clear-site-data", '"*"']], ADA), "clear-site-data"), [])
  assert.deepEqual(get(headersForVisitor([["clear-site-data", '"cache", "cookies", "storage"']], ADA), "clear-site-data"), ['"cache", "storage"'])
})

test("the relay's own headers never reach the board, and everything else does", () => {
  const forwarded = headersForBoard(
    [
      [OWNER_HEADER, "someone"],
      [ISSUED_HEADER, "1"],
      ["cookie", "__Host-frizz_session=abc"],
      ["accept", "text/html"],
    ],
    ADA
  )
  assert.deepEqual(forwarded, [
    ["cookie", "__Host-frizz_session=abc"],
    ["accept", "text/html"],
  ])
})
