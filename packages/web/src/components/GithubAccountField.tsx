import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Copy } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { GithubAccount } from "@frizz/shared"
import { useRpc } from "../lib/projectScope.tsx"
import { copyTextToClipboard } from "../lib/clipboard.ts"

// Settings → GitHub: FRIZZ'S OWN read-only GitHub sign-in (server: github-credential.ts), the one the
// PR and issue watchers, the GitHub cards and the issue picker read with. It replaced the operator's
// `gh` sign-in on 2026-11-04, which the server no longer reads at all.
//
// Signing in is GitHub's device flow: the server asks for a code, this row shows it, the person enters
// it at github.com/login/device, and the server polls GitHub until they have. The row polls the server
// meanwhile, and only then, so a signed-in Settings costs one read per open.
//
// `autoStart` is the GitHub picker's sign-in (GithubSignInSheet.tsx): someone who clicked the GitHub button
// asked for this, so the code appears at once. Settings keeps its button, because opening Settings asks for
// nothing. Once per mount, and never over a sign-in that failed, so a failure stays readable.

const BUTTON = "button-outline shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-[12px] text-fg outline-none transition-colors hover:bg-panel-2 disabled:opacity-45"

export const GITHUB_ACCOUNT_KEY = ["githubAccount"] as const

/** The sign-in's state and its three moves, for this row and the picker's sheet (GithubSignInSheet.tsx). */
export function useGithubSignIn({ autoStart = false }: { autoStart?: boolean } = {}) {
  const api = useRpc()
  const queryClient = useQueryClient()
  const account = useQuery({
    queryKey: GITHUB_ACCOUNT_KEY,
    queryFn: () => api.githubAccount(),
    refetchInterval: (query) => (query.state.data?.signIn.phase === "pending" ? 2000 : false),
  })
  const settle = (next: GithubAccount) => {
    queryClient.setQueryData(GITHUB_ACCOUNT_KEY, next)
    // The prompt box's GitHub door reads its own status query; a sign-in or out changes its answer.
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes("githubStatus") })
  }
  const start = useMutation({ mutationFn: () => api.githubSignInStart({}), onSuccess: settle })
  const cancel = useMutation({ mutationFn: () => api.githubSignInCancel({}), onSuccess: settle })
  const signOut = useMutation({ mutationFn: () => api.githubSignOut({}), onSuccess: settle })

  const data = account.data
  // A device-flow sign-in finishes on GitHub's side, with no mutation here to settle: this poll is how the
  // page learns, and the prompt box's GitHub door and the picker's sign-in must hear it too.
  const signedIn = data?.signedIn
  useEffect(() => {
    if (signedIn) void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes("githubStatus") })
  }, [signedIn, queryClient])
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!autoStart || autoStarted.current || !data) return
    // Decided once, on the first answer: reopened over a code already showing, Cancel must not start another.
    autoStarted.current = true
    if (!data.signedIn && data.appRegistered && data.signIn.phase === "idle") start.mutate()
  }, [autoStart, data, start])
  const startError = start.error instanceof Error ? start.error.message : null
  return { account, start, cancel, signOut, startError, autoStarted: autoStarted.current }
}

export function useCopyCode(code: string) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await copyTextToClipboard(code)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return { copied, copy }
}

export function GithubAccountField() {
  const { account, start, cancel, signOut, startError } = useGithubSignIn()
  const data = account.data
  // The height of the signed-in row (29px): this field leads the Settings drawer, so a shorter line here
  // would push the whole form down when the first read lands.
  if (!data) return <div className="flex min-h-[29px] items-center text-[12.5px] text-muted">{account.isError ? "Couldn't read the GitHub sign-in." : "Loading…"}</div>

  if (data.signIn.phase === "pending") {
    return <DeviceCode code={data.signIn.userCode} url={data.signIn.verificationUri} onCancel={() => cancel.mutate()} />
  }

  if (data.signedIn) {
    if (data.source === "env") {
      return <p className="m-0 text-[12.5px] text-muted">Using <code>FRIZZ_GITHUB_TOKEN</code> from the server's environment.</p>
    }
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12.5px] text-fg">
          Signed in{data.login ? <> as <span className="font-medium">@{data.login}</span></> : null}
          <span className="text-muted"> · read-only</span>
        </span>
        <button type="button" disabled={signOut.isPending} onClick={() => signOut.mutate()} className={BUTTON}>Sign out</button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {data.problem ? <p className="m-0 text-[12.5px] text-danger">The sign-in stopped working. {data.problem}</p> : null}
      {data.signIn.phase === "failed" ? <p className="m-0 text-[12.5px] text-danger">Sign-in failed: {data.signIn.message}</p> : null}
      {startError ? <p className="m-0 text-[12.5px] text-danger">{startError}</p> : null}
      {data.appRegistered ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-muted">Not signed in. The PR and issue watchers and the GitHub picker are off.</span>
          <button type="button" disabled={start.isPending} onClick={() => start.mutate()} className={BUTTON}>
            {data.problem || data.signIn.phase === "failed" ? "Sign in again" : "Sign in to GitHub"}
          </button>
        </div>
      ) : (
        <p className="m-0 text-[12.5px] text-muted">
          Not signed in. This build has no Frizz GitHub App to sign in with, so set <code>FRIZZ_GITHUB_TOKEN</code> to a read-only token in the server's environment.
        </p>
      )}
    </div>
  )
}

function DeviceCode({ code, url, onCancel }: { code: string; url: string; onCancel: () => void }) {
  const { copied, copy } = useCopyCode(code)
  return (
    <div data-github-device-code className="flex flex-col gap-2.5 rounded-md border border-border p-3">
      <span className="text-[12.5px] text-muted">Enter this code on GitHub to sign Frizz in:</span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[20px] font-semibold tracking-[0.08em] text-fg">{code}</span>
        <button type="button" aria-label="Copy the code" onClick={copy} className="inline-flex size-7 items-center justify-center rounded-md text-muted outline-none hover:bg-panel-2 hover:text-fg">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          onClick={() => { void copy() }}
          className={`${BUTTON} no-underline`}
        >
          Copy code and open GitHub
        </a>
        <button type="button" onClick={onCancel} className={`${BUTTON} text-muted`}>Cancel</button>
        <span className="ml-auto whitespace-nowrap text-[12px] text-muted">Waiting for GitHub…</span>
      </div>
    </div>
  )
}
