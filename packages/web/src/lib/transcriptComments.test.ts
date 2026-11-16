import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildMessageWithComments,
  commentsHeader,
  commentsWireText,
  findPassage,
  inTranscriptOrder,
  parseSentComments,
  parseStoredComments,
  serializeStoredComments,
  trimOffsets,
  type TranscriptComment,
} from "./transcriptComments.ts"

const comment = (over: Partial<TranscriptComment>): TranscriptComment => ({ id: "c1", sourceId: "a1", start: 0, end: 5, quote: "hello", text: "why?", ...over })

test("the wire carries the note, a counted header, and each comment under its quoted passage", () => {
  const out = buildMessageWithComments("Looks right. Two things:", [
    { quote: "Removed the byName fast path", text: "Put it back." },
    { quote: "412 passed, 1 skipped", text: "Which test is skipped?\n\nNothing should skip." },
  ])
  assert.equal(
    out,
    [
      "Looks right. Two things:",
      "",
      commentsHeader(2),
      "",
      "> Removed the byName fast path",
      "",
      "Put it back.",
      "",
      "> 412 passed, 1 skipped",
      "",
      "Which test is skipped?",
      "",
      "Nothing should skip.",
    ].join("\n"),
  )
})

test("with no words typed the comments are the whole message, and with no comments the value is untouched", () => {
  assert.equal(buildMessageWithComments("", [{ quote: "a b", text: "c" }]), `${commentsHeader(1)}\n\n> a b\n\nc`)
  assert.equal(buildMessageWithComments("just words", []), "just words")
  assert.equal(commentsWireText([]), "")
})

test("the comments go above trailing attachment lines, which other surfaces find by position", () => {
  const out = buildMessageWithComments("see this\n/tmp/shot.png", [{ quote: "the passage", text: "the remark" }])
  assert.ok(out.endsWith("\n/tmp/shot.png"), out)
  assert.ok(out.includes(`see this\n\n${commentsHeader(1)}`), out)
})

test("a passage spanning lines is quoted on one line", () => {
  assert.equal(commentsWireText([{ quote: "first line\n\n  second   line", text: "x" }]), `${commentsHeader(1)}\n\n> first line second line\n\nx`)
})

test("a sent message reads back as its note and its comments, a comment of several paragraphs whole", () => {
  const sent = buildMessageWithComments("note on top", [
    { quote: "one", text: "first\n\nstill first" },
    { quote: "two", text: "second" },
  ])
  assert.deepEqual(parseSentComments(sent), {
    note: "note on top",
    items: [
      { quote: "one", text: "first\n\nstill first" },
      { quote: "two", text: "second" },
    ],
  })
  assert.deepEqual(parseSentComments(buildMessageWithComments("", [{ quote: "q", text: "t" }])), { note: "", items: [{ quote: "q", text: "t" }] })
})

test("anything that does not read back exactly keeps its plain-text rendering", () => {
  assert.equal(parseSentComments("no comments here"), null)
  // The header's count disagrees with the blocks.
  assert.equal(parseSentComments(`${commentsHeader(3)}\n\n> a\n\nb`), null)
  // A comment whose own paragraph opens with `>` splits into a block with no comment of its own.
  assert.equal(parseSentComments(`${commentsHeader(1)}\n\n> a\n\nb\n\n> quoting myself`), null)
  // The header mid-paragraph is someone quoting it, not the serialization.
  assert.equal(parseSentComments(`intro ${commentsHeader(1)}\n\n> a\n\nb`), null)
  // A quote with nothing under it.
  assert.equal(parseSentComments(`${commentsHeader(1)}\n\n> a`), null)
})

test("stored comments survive a round trip and anything malformed is dropped, not thrown", () => {
  const list = [comment({}), comment({ id: "c2", start: 3, end: 9 })]
  assert.deepEqual(parseStoredComments(serializeStoredComments(list)), list)
  assert.equal(serializeStoredComments([]), "")
  assert.deepEqual(parseStoredComments(""), [])
  assert.deepEqual(parseStoredComments("{not json"), [])
  assert.deepEqual(parseStoredComments(JSON.stringify([{ id: "x" }, comment({ start: 4, end: 4 }), comment({ id: "ok" })])), [comment({ id: "ok" })])
})

test("comments go out in transcript order, ones whose message is not drawn last in the order written", () => {
  const messages = [{ sourceId: "u1" }, { sourceId: "a1" }, { sourceId: "a2" }]
  const ordered = inTranscriptOrder(
    [
      comment({ id: "late", sourceId: "a2", start: 0 }),
      comment({ id: "gone1", sourceId: "zz" }),
      comment({ id: "second", sourceId: "a1", start: 40 }),
      comment({ id: "first", sourceId: "a1", start: 2 }),
      comment({ id: "gone2", sourceId: "yy" }),
    ],
    messages,
  )
  assert.deepEqual(ordered.map((c) => c.id), ["first", "second", "late", "gone1", "gone2"])
})

test("a passage is found again by its words, whitespace-insensitively, nearest the old place first", () => {
  const text = "alpha beta\n gamma. alpha beta gamma."
  assert.deepEqual(findPassage(text, "beta gamma"), [6, 17])
  assert.equal(text.slice(...findPassage(text, "beta gamma", 18)!), "beta gamma")
  assert.deepEqual(findPassage(text, "beta gamma", 18), [25, 35])
  assert.equal(findPassage(text, "delta"), null)
  assert.equal(findPassage(text, "   "), null)
})

test("a selection's ends are pulled in past whitespace", () => {
  assert.deepEqual(trimOffsets("  hello \n", [0, 9]), [2, 7])
  assert.deepEqual(trimOffsets("   ", [0, 3]), [3, 3])
})
