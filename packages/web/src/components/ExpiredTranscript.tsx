// A Claude thread whose history Claude Code's own retention cleanup deleted (server claude-retention.ts).
// The period is the one the server read from the settings that apply, never an assumed 30.
export function ExpiredTranscript({ retentionDays }: { retentionDays: number }) {
  return (
    <div data-transcript-expired role="status" className="max-w-[26rem] text-center">
      <p>This conversation is no longer on disk.</p>
      <p className="mt-1.5 text-[12px]">
        Claude Code deletes a session's history {retentionDays} {retentionDays === 1 ? "day" : "days"} after its last activity, and this thread has been idle longer than that. Raise <code className="font-mono-keep">cleanupPeriodDays</code> in <code className="font-mono-keep">~/.claude/settings.json</code> to keep other threads' history longer.
      </p>
    </div>
  )
}
