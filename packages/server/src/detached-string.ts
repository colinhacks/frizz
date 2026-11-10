// ── A string that keeps nothing else alive ──────────────────────────────────────────────────────────
// V8 does not copy when it cuts a string. `s.slice(0, 200)`, `s.trim()`, a regexp capture and a
// `split` piece of 13 characters or more are SLICED strings: a pointer into the string they were cut
// from, which stays alive, whole, for as long as the piece does. A concatenation (`piece + "…"`, a
// template literal) is a CONS string holding both halves, so a capped excerpt built as
// `whole.slice(0, CAP) + MARKER` keeps `whole` too. Nothing in JavaScript can tell the two apart.
//
// That is the right trade for a string that dies with the call, and the wrong one for an excerpt that
// lives in a long-lived structure: a transcript fold retained for the life of a thread, a tail state, a
// board memo. Measured on a copy of the maintainer's boards (2026-11-09, heap snapshot under load):
// 33 MB of a 214 MB heap was whole tool payloads, whole user messages and whole assistant replies kept
// alive ONLY by the 200- to 4000-character excerpts cut from them — a 4000-character Edit preview
// holding the 100 KB file it was cut from, a 400-character first-prompt preview holding the whole prompt.
//
// `detached` returns a copy that shares no storage with its source. Call it where an excerpt is STORED,
// not where it is computed: the copy costs O(length), which is nothing next to the parse that produced
// the excerpt and is paid once, where the bytes it frees would be held for hours.
//
// The copy is also NARROWED. V8 stores a string one byte per character when every character fits in
// Latin-1, but it decides that by how the string was built, not by what it holds: a slice of a two-byte
// string is two-byte, and so is a join or concatenation with one, so an all-ASCII tool output cut from a
// reply that held one "→" costs twice what it needs to. In the retained folds of the same snapshot,
// 16 MB of strings were two-byte with not one character above U+00FF. A Latin-1 round trip through a
// Buffer rebuilds such a string one-byte, exactly; a string that does hold a wider character keeps it
// and is copied as it is.
//
// How: `" " + s` is a cons string; slicing it flattens the cons into a new sequential string (a copy of
// `s` plus one character) and returns a slice of THAT, so the only parent left is the copy. The Latin-1
// round trip makes a fresh one-byte string outright. Measured 2026-11-09 for 300 / 4,000 / 16,000
// characters: 0.2 / 0.6 / 1.8 us for the cons copy, 0.8 / 5.7 / 20 us with the narrowing check — paid
// once per stored excerpt, beside a parse that took far longer to produce it. V8 never slices or conses
// a string shorter than 13 characters, so those are returned as they are.
const SLICE_MIN_LENGTH = 13
const WIDER_THAN_LATIN1 = /[^\x00-\xff]/

export function detached(s: string): string
export function detached(s: string | undefined): string | undefined
export function detached(s: string | undefined): string | undefined {
  if (s === undefined || s.length < SLICE_MIN_LENGTH) return s
  if (WIDER_THAN_LATIN1.test(s)) return (" " + s).slice(1)
  return Buffer.from(s, "latin1").toString("latin1")
}
