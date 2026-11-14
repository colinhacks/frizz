// A Claude thread whose history Claude Code's own retention cleanup deleted (server claude-retention.ts).
// The period is the one the server read from the settings that apply, never an assumed 30.
//
// The code spans are `leading-none`: the mono face's taller ascent and descent, on the paragraph's
// inherited 17.14px line height, pushed each line holding one ~1px down (measured in sans, 2026-11-14:
// a 17.1px line pitch, then 18.2px). At line-height 1 the span's box sits inside the line's own strut.
export function ExpiredTranscript({ retentionDays }: { retentionDays: number }) {
  return (
    <div data-transcript-expired role="status" className="max-w-[26rem] text-center">
      <p>This conversation is no longer on disk.</p>
      <p className="mt-1.5 text-[12px]">
        Claude Code deletes a session's history {retentionDays} {retentionDays === 1 ? "day" : "days"} after its last activity, and this thread has been idle longer than that. Raise <code className="font-mono-keep leading-none">cleanupPeriodDays</code> in <code className="font-mono-keep leading-none">~/.claude/settings.json</code> to keep other threads' history longer.
      </p>
    </div>
  )
}
