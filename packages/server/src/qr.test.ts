import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"
import qrcode from "qrcode-generator"
import { drawsBlockElements, qrAreaOf, qrErrorCorrectionFor, qrSize, qrStyleFor, qrWidth, renderQr, renderQrLines } from "./qr.ts"

const QUIET_ZONE = 4
const SAMPLE = "https://colin.frizz.sh/?frizz_code=pW58RJTeG4IMkc6ojgC"
const DARK_BG = "\x1b[48;5;232m"
const LIGHT_BG = "\x1b[48;5;231m"
const DARK_FG = "\x1b[38;5;232m"
const LIGHT_FG = "\x1b[38;5;231m"
/** A terminal that announces nothing: the conservative case. */
const UNKNOWN_ENV: NodeJS.ProcessEnv = { TERM: "xterm-256color" }
const ROOMY = { columns: 200, rows: 100 }

/** What the encoder itself says, so the test compares the RENDERING against ground truth, not itself. */
function truth(value: string) {
  const code = qrcode(0, "M")
  code.addData(value)
  code.make()
  const modules = code.getModuleCount()
  return {
    modules,
    size: modules + QUIET_ZONE * 2,
    dark: (x: number, y: number) => {
      const mx = x - QUIET_ZONE
      const my = y - QUIET_ZONE
      if (mx < 0 || my < 0 || mx >= modules || my >= modules) return false
      return code.isDark(my, mx)
    },
  }
}

/** Each terminal cell of a coloured row: the SGR sequences that precede its one character, and it. */
function cells(line: string): Array<{ sgr: string[]; glyph: string }> {
  const out: Array<{ sgr: string[]; glyph: string }> = []
  const re = /((?:\x1b\[[0-9;]*m)*)(.)/gu
  for (const [, codes, glyph] of line.replace(/\x1b\[0m$/u, "").matchAll(re)) {
    out.push({ sgr: codes!.match(/\x1b\[[0-9;]*m/gu) ?? [], glyph: glyph! })
  }
  return out
}

/**
 * Rebuild the module matrix from COLOURED output the way a terminal paints it: a cell's background
 * fills it, a half block's ink covers its half. Background colour carries over between cells (as SGR
 * does), so the paint style's run-length colouring is honoured.
 */
function paintedModules(lines: string[], style: "half" | "paint"): boolean[][] {
  const rows: boolean[][] = []
  for (const line of lines) {
    let background: boolean | undefined
    let ink: boolean | undefined
    const top: boolean[] = []
    const bottom: boolean[] = []
    for (const { sgr, glyph } of cells(line)) {
      for (const code of sgr) {
        if (code === DARK_BG) background = true
        else if (code === LIGHT_BG) background = false
        else if (code === DARK_FG) ink = true
        else if (code === LIGHT_FG) ink = false
        else assert.fail(`unexpected SGR ${JSON.stringify(code)}`)
      }
      assert.notEqual(background, undefined, "every cell has an explicit background")
      if (glyph === " ") {
        top.push(background!)
        bottom.push(background!)
      } else {
        assert.equal(style, "half", "only the half style draws glyphs")
        assert.notEqual(ink, undefined, "a glyph has an explicit ink colour")
        top.push(glyph === "▀" ? ink! : background!)
        bottom.push(glyph === "▄" ? ink! : background!)
      }
    }
    if (style === "paint") {
      assert.equal(top.length % 2, 0, "two columns per module")
      rows.push(top.filter((_, i) => i % 2 === 0))
      for (let i = 0; i < top.length; i += 2) assert.equal(top[i], top[i + 1], "both columns of a module agree")
    } else {
      rows.push(top, bottom)
    }
  }
  return rows
}

/** Hand pixels rebuilt from a module matrix to jsQR, an independent decoder. */
function decode(modules: boolean[][]): string | undefined {
  const require_ = createRequire(import.meta.url)
  const jsQR = require_("jsqr") as (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null
  const size = modules[0]!.length
  const scale = 4
  const width = size * scale
  const height = modules.length * scale
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < modules.length; y++) {
    for (let x = 0; x < size; x++) {
      const value = modules[y]![x] ? 0 : 255
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const at = ((y * scale + dy) * width + (x * scale + dx)) * 4
          pixels[at] = pixels[at + 1] = pixels[at + 2] = value
          pixels[at + 3] = 255
        }
      }
    }
  }
  return jsQR(pixels, width, height)?.data
}

test("the half-block rendering round-trips back to the exact module matrix", () => {
  // The bug this exists for: pairing two module ROWS into one terminal cell is easy to get off by one,
  // and the result still LOOKS like a QR while scanning as garbage or not at all. So reconstruct the
  // matrix from the rendered glyphs and compare every cell against the encoder.
  const { size, dark } = truth(SAMPLE)
  const lines = renderQrLines(SAMPLE, { plain: true })
  assert.equal(lines.length, Math.ceil(size / 2), "one terminal row per two module rows")
  for (const line of lines) assert.equal(line.length, size, "every row is the full width incl. quiet zone")

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const glyph = lines[Math.floor(y / 2)]![x]!
      const isTop = y % 2 === 0
      const rendered = isTop ? glyph === "#" || glyph === "^" : glyph === "#" || glyph === "v"
      assert.equal(rendered, dark(x, y), `module (${x},${y}) rendered wrong`)
    }
  }
})

test("the quiet zone is drawn on all four sides, not assumed", () => {
  // A QR flush against surrounding terminal text does not scan, however correct the code itself is.
  const { size } = truth(SAMPLE)
  const lines = renderQrLines(SAMPLE, { plain: true })
  const blankRow = " ".repeat(size)
  for (let i = 0; i < QUIET_ZONE / 2; i++) {
    assert.equal(lines[i], blankRow, `top quiet-zone row ${i} is not blank`)
    assert.equal(lines[lines.length - 1 - i], blankRow, `bottom quiet-zone row ${i} is not blank`)
  }
  for (const line of lines) {
    assert.equal(line.slice(0, QUIET_ZONE), " ".repeat(QUIET_ZONE), "left quiet zone")
    assert.equal(line.slice(-QUIET_ZONE), " ".repeat(QUIET_ZONE), "right quiet zone")
  }
})

test("both coloured styles paint the exact module matrix, quiet zone included", () => {
  // Rebuilt the way a terminal paints the cells, so a polarity or pairing mistake in the COLOURED path
  // (the one a phone actually sees) fails here even though the plain path is right.
  const { size, dark } = truth(SAMPLE)
  for (const style of ["half", "paint"] as const) {
    const modules = paintedModules(renderQrLines(SAMPLE, { style }), style)
    assert.ok(modules.length >= size, `${style}: every module row is present`)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) assert.equal(modules[y]![x], dark(x, y), `${style}: module (${x},${y})`)
    }
  }
})

test("colours come from the fixed 256-colour cube, never the 16 a theme can remap", () => {
  // Every base16 light theme makes colour 0 its LIGHT background and 15 its DARK text, which turned the
  // old `38;5;0`/`48;5;15` into an inverted code that no decoder read; VS Code's Light+ greys 15 to
  // #a5a5a5. 232 and 231 are fixed; 16 is avoided because base16-shell rewrites 16-21.
  for (const style of ["half", "paint"] as const) {
    const rendered = renderQr(SAMPLE, { style })
    const codes = new Set(rendered.match(/\x1b\[[0-9;]*m/gu))
    assert.deepEqual(
      [...codes].filter((code) => code !== "\x1b[0m").sort(),
      (style === "half" ? [DARK_FG, LIGHT_FG, DARK_BG, LIGHT_BG] : [DARK_BG, LIGHT_BG]).sort(),
      `${style}: only the fixed cube colours`,
    )
    for (const line of rendered.split("\n")) assert.ok(line.endsWith("\x1b[0m"), `${style}: every row resets`)
  }
})

test("a half block's shortfall falls on an edge where the background is the right colour", () => {
  // A font-drawn half block does not fill its cell (SF Mono's and Menlo's stop 14-16% short of the top;
  // extra line height leaves a strip at both edges), and wherever it falls short the cell's BACKGROUND
  // shows. The old rendering drew dark ink over a light field, so the miss striped every dark run and
  // the finder patterns came out combed (0% decoded with Menlo, SF Mono or Monaco when drawn from the
  // font). The rule: `▄` with the top module as background — its miss at the top shows the top module's
  // own colour — unless its bottom-edge miss would split a run continuing below and `▀`'s top-edge miss
  // would not split one continuing above.
  const { size, dark } = truth(SAMPLE)
  const lines = renderQrLines(SAMPLE, { style: "half" })
  let lower = 0
  let upper = 0
  for (let row = 0; row < lines.length; row++) {
    const rowCells = cells(lines[row]!)
    assert.equal(rowCells.length, size, `row ${row} has one cell per column`)
    for (let x = 0; x < size; x++) {
      const y = row * 2
      const top = dark(x, y)
      const bottom = y + 1 < size ? dark(x, y + 1) : false
      const { sgr, glyph } = rowCells[x]!
      const where = `cell (${x},${row})`
      if (top === bottom) {
        assert.equal(glyph, " ", `${where}: a uniform pair is a bare space`)
        assert.deepEqual(sgr, [top ? DARK_BG : LIGHT_BG], `${where}: painted as background alone`)
        continue
      }
      const above = y > 0 ? dark(x, y - 1) : false
      const below = y + 2 < size ? dark(x, y + 2) : false
      if (below === bottom && above !== top) {
        upper++
        assert.equal(glyph, "▀", `${where}: the run below would be split by ▄, the one above by nothing`)
        assert.deepEqual(sgr, [top ? DARK_FG : LIGHT_FG, bottom ? DARK_BG : LIGHT_BG], `${where}: ink is the top module`)
      } else {
        lower++
        assert.equal(glyph, "▄", `${where}: ▄ by default`)
        assert.deepEqual(sgr, [bottom ? DARK_FG : LIGHT_FG, top ? DARK_BG : LIGHT_BG], `${where}: ink is the bottom module`)
      }
    }
  }
  assert.ok(lower > 0 && upper > 0, "the sample exercises both choices")
})

test("the paint style is background colour alone, two columns and one row per module", () => {
  // No glyph means nothing for a font, a line height or a letter spacing to misplace: 100% in every
  // configuration measured, at four times the area of the half style.
  const { size } = truth(SAMPLE)
  const lines = renderQrLines(SAMPLE, { style: "paint" })
  assert.equal(lines.length, size, "one terminal row per module row")
  for (const line of lines) {
    const rowCells = cells(line)
    assert.equal(rowCells.length, size * 2, "two columns per module")
    assert.ok(rowCells.every((cell) => cell.glyph === " "), "no glyph anywhere")
  }
  assert.deepEqual(qrSize(SAMPLE, "paint"), { columns: size * 2, rows: size })
})

test("both styles decode back to the URL through a real QR decoder", () => {
  // Every other test here checks the matrix against the encoder that produced it, which cannot catch a
  // whole-code mistake both sides agree on. This one rebuilds pixels from the RENDERED output and hands
  // them to an independent decoder — the closest thing to pointing a phone at the terminal.
  const plain = renderQrLines(SAMPLE, { plain: true })
  const fromPlain = Array.from({ length: plain[0]!.length }, (_, y) =>
    [...plain[Math.floor(y / 2)]!].map((glyph) => (y % 2 === 0 ? glyph === "#" || glyph === "^" : glyph === "#" || glyph === "v")),
  )
  assert.equal(decode(fromPlain), SAMPLE, "plain half blocks")
  assert.equal(decode(paintedModules(renderQrLines(SAMPLE, { style: "half" }), "half")), SAMPLE, "coloured half blocks")
  assert.equal(decode(paintedModules(renderQrLines(SAMPLE, { style: "paint" }), "paint")), SAMPLE, "background paint")
})

test("only a terminal known to draw block elements itself counts as one", () => {
  // Conservative by design: a false "yes" puts a glyph code on a font-drawn terminal that may stripe it,
  // a false "no" only costs the larger code when there is room.
  for (const env of [
    { TERM_PROGRAM: "iTerm.app" },
    { TERM_PROGRAM: "WezTerm" },
    { TERM_PROGRAM: "ghostty" },
    { TERM_PROGRAM: "WarpTerminal" },
    { TERM_PROGRAM: "vscode" },
    { TERM: "xterm-kitty" },
    { TERM: "alacritty" },
    { TERM: "xterm-256color", LC_TERMINAL: "iTerm2" },
    { TERM: "xterm-256color", WT_SESSION: "a1b2" },
    { TERM: "xterm-256color", VTE_VERSION: "7600" },
  ]) {
    assert.equal(drawsBlockElements(env), true, JSON.stringify(env))
  }
  for (const env of [
    UNKNOWN_ENV,
    { TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" },
    // A multiplexer forwards cells to whatever terminal is attached now, which these variables may not name.
    { TERM_PROGRAM: "tmux", TERM: "tmux-256color" },
    { TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/tmux-501/default,1,0" },
    { TERM: "screen-256color", KITTY_WINDOW_ID: "1" },
  ]) {
    assert.equal(drawsBlockElements(env), false, JSON.stringify(env))
  }
})

test("the glyph-free code is chosen only for an unknown terminal that has room for it", () => {
  const paint = qrSize(SAMPLE, "paint")
  // No area: the half style, the only one guaranteed to fit an 80x24 window.
  assert.equal(qrStyleFor(SAMPLE, { env: UNKNOWN_ENV }), "half")
  // A block-drawing terminal gets the compact code even with room to spare.
  assert.equal(qrStyleFor(SAMPLE, { env: { TERM_PROGRAM: "ghostty" }, area: ROOMY }), "half")
  // An unknown terminal gets the glyph-free code exactly when it fits.
  assert.equal(qrStyleFor(SAMPLE, { env: UNKNOWN_ENV, area: ROOMY }), "paint")
  assert.equal(qrStyleFor(SAMPLE, { env: UNKNOWN_ENV, area: paint }), "paint")
  assert.equal(qrStyleFor(SAMPLE, { env: UNKNOWN_ENV, area: { ...paint, columns: paint.columns - 1 } }), "half")
  assert.equal(qrStyleFor(SAMPLE, { env: UNKNOWN_ENV, area: { ...paint, rows: paint.rows - 1 } }), "half")
  // renderQrLines applies the same rule.
  assert.equal(renderQrLines(SAMPLE, { env: UNKNOWN_ENV, area: ROOMY }).length, paint.rows)
  assert.equal(renderQrLines(SAMPLE, { env: UNKNOWN_ENV, area: { columns: 80, rows: 24 } }).length, qrSize(SAMPLE).rows)
})

test("a surface's area is its window minus its indent and frame, and nothing for an unsized stream", () => {
  assert.deepEqual(qrAreaOf({ columns: 120, rows: 50 }, { indent: 2, rows: 7 }), { columns: 118, rows: 43 })
  // A pipe or a test double has no size, which keeps the code compact rather than guessing.
  assert.equal(qrAreaOf({}, { indent: 2, rows: 7 }), undefined)
})

test("a launch-sized code fits an 80x24 terminal", () => {
  // The whole reason for half blocks. If this regresses, the QR silently stops being scannable because
  // the terminal wraps it — which looks like a rendering bug and is actually a sizing one.
  const width = qrWidth(SAMPLE)
  assert.ok(width <= 80, `QR is ${width} columns, wider than an 80-column terminal`)
  assert.ok(renderQrLines(SAMPLE).length <= 24, "QR is taller than a 24-row terminal")
})

test("a random frizz.sh sign-in link drops to error correction L where only that fits, and still decodes", () => {
  // 20-character random host plus a 22-character code: 72 characters, version 5 at M (23 rows), which an
  // 80x24 done screen cannot hold under its message, URL and way back (21 rows).
  const random = "https://abcdefghjkmnpqrstuvw.frizz.sh/?frizz_code=q7Hn2xVdL0pRk4WmTz9bYa"
  const area = { columns: 78, rows: 21 }
  assert.ok(qrSize(random, "half", "M").rows > area.rows, "the case this exists for: M does not fit")
  assert.equal(qrErrorCorrectionFor(random, area), "L")
  const lines = renderQrLines(random, { area, env: { TERM_PROGRAM: "ghostty" } })
  assert.ok(lines.length <= area.rows, `${lines.length} rows`)
  assert.equal(decode(paintedModules(lines, "half")), random)
  // M wherever M fits, and with no area at all.
  assert.equal(qrErrorCorrectionFor(SAMPLE, area), "M")
  assert.equal(qrErrorCorrectionFor(random), "M")
  assert.equal(qrErrorCorrectionFor(random, ROOMY), "M")
})

test("rendering refuses an empty value rather than emitting an unscannable box", () => {
  assert.throws(() => renderQr(""), /requires a value/)
})
