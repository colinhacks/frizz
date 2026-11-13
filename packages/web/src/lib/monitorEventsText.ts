// THE EVENTS A CLAUDE CODE MONITOR DELIVERED, as the text its drawer shows (BackgroundShellSheet).
//
// One event per entry, each led by the time it reached the worker, with a multi-line event's later lines
// indented under its first so a batch (`==> file <==` and the lines after it) reads as one event:
//
//    8:40:36 PM  ==> gates-fts5.log <==
//                pass  prepare      0s
//    8:40:37 PM  pass  lab-sqlite   1s
//
// The times carry seconds, unlike the transcript's hairline (messageTime.ts), because a Monitor's events
// routinely land within one minute of each other and the gaps between them are the reading. A day line
// heads each day only when the events are not all from today, in the hairline's words (`Yesterday`,
// `Friday`, `Oct 22`). Events the server's caps let go are said once, at the top.

import { dayAndTime } from "./messageTime.ts"

export interface MonitorEventLine {
  text: string
  at: string | null
}

export function monitorEventsText(events: readonly MonitorEventLine[], dropped = 0, now: Date = new Date(), locale?: string): string {
  if (events.length === 0) return ""
  const times = events.map((e) => {
    const ms = e.at ? Date.parse(e.at) : Number.NaN
    return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", second: "2-digit" }) : ""
  })
  const days = events.map((e) => (e.at && Number.isFinite(Date.parse(e.at)) ? dayAndTime(e.at, now, locale).day : ""))
  const width = Math.max(...times.map((t) => t.length))
  const showDays = days.some((d) => d && d !== "Today")
  const out: string[] = []
  if (dropped > 0) out.push(`${dropped} earlier event${dropped === 1 ? " was" : "s were"} not kept.`, "")
  let lastDay: string | undefined
  events.forEach((event, i) => {
    if (showDays && days[i] && days[i] !== lastDay) {
      if (out.length > 0) out.push("")
      out.push(days[i])
      lastDay = days[i]
    }
    const stamp = width > 0 ? `${times[i].padStart(width)}  ` : ""
    const indent = " ".repeat(stamp.length)
    const [first = "", ...rest] = event.text.split("\n")
    out.push(stamp + first, ...rest.map((line) => indent + line))
  })
  return out.join("\n")
}
