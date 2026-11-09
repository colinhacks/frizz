import qrcode from "qrcode-generator"

/**
 * Render a string as a QR code a phone can read off a terminal — any terminal, any font, any theme.
 *
 * Three decisions, each the difference between "scans" and "does not scan" for some real set of people.
 * The measurements behind them (xterm.js in headless Chrome across its renderers, nine fonts, line
 * heights 1.0–1.5, three themes, each shot decoded by zxing-cpp and Apple Vision after a simulated
 * camera) are summarised in the commit that introduced this comment.
 *
 * TWO STYLES, AND THE GLYPH IS THE RISK. A terminal cell is about twice as tall as it is wide, so a
 * square module is either half a cell (`half`: two module rows per cell, split by `▀`/`▄`; 41x21 cells
 * for a typical sign-in link) or two whole cells side by side (`paint`: background colour only, no glyph
 * at all; 82x41, four times the area). One cell per module is a code stretched 2:1, which Apple Vision
 * refused in about two thirds of the configurations measured even when every pixel was right.
 *
 * `half` is exact wherever the terminal draws block elements ITSELF — iTerm2, kitty, WezTerm, Alacritty,
 * Ghostty, Warp, Windows Terminal, VTE, and VS Code's default WebGL renderer: 100% at every line height
 * and letter spacing measured. Where the terminal draws `▀` from the FONT (macOS Terminal.app, VS Code's
 * DOM fallback, conhost) the glyph rarely fills the cell: SF Mono's and Menlo's half blocks stop 14–16%
 * short of the top of the line box, Monaco has none at all, and any extra line height or letter spacing
 * opens a gap the font knows nothing about. The previous rendering (always dark ink, so `▀` over a dark
 * top module) let that gap show the light field through every dark run and striped the finder patterns:
 * with Menlo, SF Mono or Monaco at line height 1.0 it decoded in 0% of the font-drawn configurations.
 * `paint` has no glyph to misplace and decoded in all of them. So: `half` where the terminal is known to
 * draw block elements itself, `paint` where it is not and the caller says there is room, and `half` as
 * the fallback when there is not.
 *
 * A HALF BLOCK'S SHORTFALL MUST SHOW THE RIGHT COLOUR. In a mixed cell the glyph draws one module and
 * the cell's background is the other, so wherever a font-drawn glyph falls short the background shows.
 * `▄` (ink = bottom module, background = top module) falls short at the TOP edge — every font measured
 * reaches the bottom of its line box — where the background IS the top module's colour, so the miss is
 * invisible. Extra line height also opens a strip at the bottom edge, where the top colour is wrong; that
 * strip only shows when the module below continues the bottom module's colour, and in that case `▀` over
 * the bottom module (whose own miss is at the top) is used instead, unless the module above continues
 * the top colour and it would stripe too. That rule took font-drawn line heights 1.0–1.2 from 6–61% to
 * 100%; a uniform cell stays a bare space over its colour, with no glyph at all.
 *
 * COLOURS FROM THE 256 CUBE, NEVER THE 16 THEMEABLE ONES. Indices 0–15 belong to the user's theme: every
 * base16 light scheme makes colour 0 its LIGHT background and 15 its DARK text, which turned the previous
 * `38;5;0`/`48;5;15` into an inverted code no decoder read, and VS Code's Light+ greys 15 to `#a5a5a5`.
 * `232` (#080808) and `231` (#ffffff) are fixed in every 256-colour terminal; `16` is avoided because
 * base16-shell rewrites 16–21. The quiet zone is drawn, not assumed — a code flush against surrounding
 * text is unreadable even when the code itself is perfect.
 */

const DARK = 232
const LIGHT = 231
const fg = (dark: boolean) => `\x1b[38;5;${dark ? DARK : LIGHT}m`
const bg = (dark: boolean) => `\x1b[48;5;${dark ? DARK : LIGHT}m`
const RESET = "\x1b[0m"
const UPPER_HALF = "▀"
const LOWER_HALF = "▄"
/** Four modules is the spec's minimum quiet zone; less and the finder patterns stop being findable. */
const QUIET_ZONE = 4

export type QrErrorCorrection = "L" | "M" | "Q" | "H"

/** `half`: two module rows per cell, split by a half block. `paint`: two background-only cells per module. */
export type QrStyle = "half" | "paint"

/** The cells the code ITSELF may occupy — the caller's own indent and framing lines already subtracted. */
export interface QrArea {
  columns: number
  rows: number
}

export interface QrRenderOptions {
  /**
   * Error correction. "M" tolerates ~15% damage, which covers a slightly out-of-focus phone camera. Left
   * unset, it is "M", or "L" where only that fits `area` (qrErrorCorrectionFor).
   */
  errorCorrection?: QrErrorCorrection
  /** Emit plain `#`/space instead of ANSI colour, for tests and non-TTY sinks. */
  plain?: boolean
  /** Force a style. Otherwise `qrStyleFor` picks one from the terminal and `area`. */
  style?: QrStyle
  /**
   * Room for the code. Without it the code is always `half`, the only style that fits an 80x24 window;
   * with it, a terminal not known to draw block elements itself gets the glyph-free `paint` when it fits.
   */
  area?: QrArea
  /** The environment to identify the terminal from. Tests pass their own; callers leave it. */
  env?: NodeJS.ProcessEnv
}

/** Terminals that announce themselves by `TERM_PROGRAM` and draw U+2580..U+259F as rectangles, not font glyphs. */
const BLOCK_DRAWING_PROGRAMS = new Set(["iTerm.app", "WezTerm", "ghostty", "WarpTerminal", "vscode"])
/** The same terminals by `TERM`, which unlike `TERM_PROGRAM` survives an ssh hop. */
const BLOCK_DRAWING_TERMS = new Set(["xterm-kitty", "xterm-ghostty", "alacritty", "wezterm"])

/**
 * True when the terminal is KNOWN to draw block elements itself, so a half block fills its cell exactly
 * whatever the font, line height or letter spacing. Deliberately conservative: anything unrecognised is
 * assumed to draw from the font, which only costs the larger code when there is room for it.
 *
 * Under tmux or screen the cells reach whichever terminal is attached NOW, while these variables may
 * describe the one that started the session, so a multiplexer is always "unknown". VS Code counts because
 * its default renderer (WebGL) draws block elements itself; its DOM fallback uses the font, where `half`
 * still measured 100% at line heights up to 1.2.
 */
export function drawsBlockElements(env: NodeJS.ProcessEnv = process.env): boolean {
  const term = env.TERM ?? ""
  if (env.TMUX || env.STY || env.TERM_PROGRAM === "tmux" || term.startsWith("screen") || term.startsWith("tmux")) return false
  if (BLOCK_DRAWING_PROGRAMS.has(env.TERM_PROGRAM ?? "")) return true
  if (BLOCK_DRAWING_TERMS.has(term)) return true
  // iTerm2 also sets LC_TERMINAL, which macOS's ssh forwards by default.
  if (env.LC_TERMINAL === "iTerm2") return true
  return Boolean(
    env.KITTY_WINDOW_ID || env.ALACRITTY_WINDOW_ID || env.WEZTERM_PANE || env.GHOSTTY_RESOURCES_DIR || env.WT_SESSION || env.VTE_VERSION,
  )
}

/** True when the module at (x, y) is dark; anything outside the code is quiet zone, hence light. */
type ModuleAt = (x: number, y: number) => boolean

function encode(value: string, errorCorrection: QrErrorCorrection): { size: number; at: ModuleAt } {
  // Type 0 asks the encoder to pick the smallest version that fits.
  const code = qrcode(0, errorCorrection)
  code.addData(value)
  code.make()
  const modules = code.getModuleCount()
  const size = modules + QUIET_ZONE * 2
  return {
    size,
    at: (x, y) => {
      const mx = x - QUIET_ZONE
      const my = y - QUIET_ZONE
      if (mx < 0 || my < 0 || mx >= modules || my >= modules) return false
      return code.isDark(my, mx)
    },
  }
}

function sizeOf(size: number, style: QrStyle): QrArea {
  return style === "paint" ? { columns: size * 2, rows: size } : { columns: size, rows: Math.ceil(size / 2) }
}

/** Columns and rows the code occupies in a style, quiet zone included. */
export function qrSize(value: string, style: QrStyle = "half", errorCorrection: QrErrorCorrection = "M"): QrArea {
  return sizeOf(encode(value, errorCorrection).size, style)
}

/** Width in terminal columns, so a caller can centre or box the code without rendering it first. */
export function qrWidth(value: string, errorCorrection: QrErrorCorrection = "M", style: QrStyle = "half"): number {
  return qrSize(value, style, errorCorrection).columns
}

/** The one rule: `half` in a block-drawing terminal or without room, otherwise the glyph-free `paint`. */
export function qrStyleFor(
  value: string,
  options: { area?: QrArea; env?: NodeJS.ProcessEnv; errorCorrection?: QrErrorCorrection } = {},
): QrStyle {
  const { area } = options
  if (!area || drawsBlockElements(options.env)) return "half"
  const paint = qrSize(value, "paint", options.errorCorrection)
  return paint.columns <= area.columns && paint.rows <= area.rows ? "paint" : "half"
}

/**
 * The room a full-screen surface leaves for the code: its window minus the indent it prints the code at
 * and the rows it spends on everything else. Undefined when the stream is not a sized terminal, which
 * keeps the code `half`.
 */
export function qrAreaOf(stream: { columns?: number; rows?: number }, frame: { indent: number; rows: number }): QrArea | undefined {
  if (!stream.columns || !stream.rows) return undefined
  return { columns: stream.columns - frame.indent, rows: stream.rows - frame.rows }
}

function halfLines(size: number, at: ModuleAt, plain: boolean): string[] {
  const lines: string[] = []
  // Two module rows per terminal row. An odd final row pairs with quiet zone, which is light anyway.
  for (let y = 0; y < size; y += 2) {
    let line = ""
    for (let x = 0; x < size; x++) {
      const top = at(x, y)
      const bottom = y + 1 < size ? at(x, y + 1) : false
      if (plain) {
        line += top && bottom ? "#" : top ? "^" : bottom ? "v" : " "
        continue
      }
      if (top === bottom) {
        line += `${bg(top)} `
        continue
      }
      // The header's rule: `▄` over the top module, unless its bottom-edge miss would stripe a run that
      // continues below while `▀`'s top-edge miss would not stripe one that continues above.
      const above = y > 0 ? at(x, y - 1) : false
      const below = y + 2 < size ? at(x, y + 2) : false
      line += below === bottom && above !== top ? `${fg(top)}${bg(bottom)}${UPPER_HALF}` : `${fg(bottom)}${bg(top)}${LOWER_HALF}`
    }
    lines.push(plain ? line : `${line}${RESET}`)
  }
  return lines
}

function paintLines(size: number, at: ModuleAt, plain: boolean): string[] {
  const lines: string[] = []
  for (let y = 0; y < size; y++) {
    let line = ""
    let last: boolean | undefined
    for (let x = 0; x < size; x++) {
      const dark = at(x, y)
      if (plain) line += dark ? "##" : "  "
      else {
        if (dark !== last) line += bg(dark)
        line += "  "
      }
      last = dark
    }
    lines.push(plain ? line : `${line}${RESET}`)
  }
  return lines
}

/**
 * The strongest error correction whose `half` code fits `area`: "M", or "L" where M needs a larger QR
 * version than the area holds and L does not. Without an area, "M".
 *
 * L tolerates ~7% damage rather than ~15%, which a phone reading a sharp screen does not need; a code
 * whose top rows scroll off the window is unreadable at any level. The case that needed it: a random
 * frizz.sh sign-in link (72 characters) is version 5 at M, 23 rows, and an 80x24 done screen has room
 * for 21 under its message, URL and way back; at L it is version 4, 21 rows.
 */
export function qrErrorCorrectionFor(value: string, area?: QrArea): QrErrorCorrection {
  if (!area) return "M"
  const fits = (size: QrArea) => size.columns <= area.columns && size.rows <= area.rows
  const medium = qrSize(value, "half", "M")
  if (fits(medium)) return "M"
  return qrSize(value, "half", "L").rows < medium.rows ? "L" : "M"
}

/**
 * The code as terminal lines, quiet zone included. Returns lines rather than a blob so a caller can
 * centre it, box it, or repaint a region without re-encoding.
 */
export function renderQrLines(value: string, options: QrRenderOptions = {}): string[] {
  if (!value) throw new Error("renderQr requires a value")
  const errorCorrection = options.errorCorrection ?? qrErrorCorrectionFor(value, options.area)
  const { size, at } = encode(value, errorCorrection)
  const style = options.style ?? qrStyleFor(value, { area: options.area, env: options.env, errorCorrection })
  return style === "paint" ? paintLines(size, at, options.plain ?? false) : halfLines(size, at, options.plain ?? false)
}

/** Convenience for printing straight to a terminal. */
export function renderQr(value: string, options: QrRenderOptions = {}): string {
  return renderQrLines(value, options).join("\n")
}
