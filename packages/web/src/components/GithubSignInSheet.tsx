import { ArrowUpRight, Check, Copy, Github, Loader2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Overlay } from "./NewThreadModal.tsx"
import { useCopyCode, useGithubSignIn } from "./GithubAccountField.tsx"

// THE SHEET the GitHub button opens while Frizz is signed out: one short job, so one column. Read the
// code, click once, wait. Picked from a mockup sheet with the maintainer on 2026-11-05, replacing a
// paragraph, a bordered box and a footnote that all read at one weight. Settings keeps its own compact
// row (GithubAccountField), since there the sign-in is one setting among many.
//
// It stays open until the sign-in lands, when GithubPickerModal swaps it for the picker in place. Cancel
// withdraws the code and closes it; Escape and the scrim only close it, so a code being entered on GitHub
// keeps working and reopening shows the same one.

const FRIZZ_APP_INSTALL_URL = "https://github.com/apps/frizz-agent-console/installations/new"
const PRIMARY = "button-outline flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-fg text-[13px] font-medium text-bg no-underline outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
const QUIET = "whitespace-nowrap rounded text-[12.5px] text-muted outline-none hover:text-fg focus-visible:text-fg"
const NOTE = "m-0 mt-1 text-[13px] text-muted"
// Holds the sheet's height from "Getting a code…" through the code to a failure, so nothing below jumps.
const CODE_SLOT = "my-[18px] flex min-h-[32px] w-full items-center justify-center"

export function GithubSignInSheet({ onClose }: { onClose: () => void }) {
  // Focus in the panel, or Escape has nothing to land on: nothing here takes focus by itself.
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => panel.current?.focus(), [])
  return (
    <Overlay onClose={onClose}>
      <div
        ref={panel}
        tabIndex={-1}
        data-github-sign-in
        className="flex w-[420px] max-w-[90vw] flex-col items-center rounded-xl border border-border bg-panel p-[22px] text-center shadow-2xl shadow-shadow-ink/50 outline-none"
        onKeyDownCapture={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <Github size={20} aria-hidden="true" className="text-muted" />
        <h2 className="m-0 mt-2.5 text-[15px] font-medium">Sign in to GitHub</h2>
        <SignInBody onClose={onClose} />
        <p className="m-0 mt-3 w-full border-t border-border pt-3 text-[12px] leading-normal text-balance text-muted">
          Read-only access to code, issues, PRs and checks. Private repos also need{" "}
          <a href={FRIZZ_APP_INSTALL_URL} target="_blank" rel="noreferrer" className="text-fg underline underline-offset-2">the Frizz GitHub App installed</a>.
        </p>
      </div>
    </Overlay>
  )
}

function SignInBody({ onClose }: { onClose: () => void }) {
  const { account, start, cancel, startError, autoStarted } = useGithubSignIn({ autoStart: true })
  const data = account.data
  if (!data) {
    return <p className={`${NOTE} ${account.isError ? "text-danger" : ""}`}>{account.isError ? "Couldn't read the GitHub sign-in." : "Loading…"}</p>
  }
  if (data.signIn.phase === "pending") {
    return <DeviceCode code={data.signIn.userCode} url={data.signIn.verificationUri} onCancel={() => { cancel.mutate(); onClose() }} />
  }
  // Only for the moment before the picker replaces this sheet.
  if (data.signedIn) return <p className={NOTE}>Signed in.</p>
  if (!data.appRegistered) {
    return (
      <>
        <p className={NOTE}>This build has no Frizz GitHub App to sign in with, so set <code>FRIZZ_GITHUB_TOKEN</code> to a read-only token in the server's environment.</p>
        <button type="button" onClick={onClose} className={`${QUIET} mt-3`}>Close</button>
      </>
    )
  }
  const failure = data.signIn.phase === "failed" ? data.signIn.message : startError
  // An idle sign-in nothing is about to start: cancelled from Settings while this sheet stood open.
  if (failure || (!start.isPending && autoStarted)) {
    return (
      <>
        <p className={NOTE}>Enter a code on GitHub to connect Frizz.</p>
        <div className={CODE_SLOT}><span className="text-[13px] text-danger">{failure}</span></div>
        <button type="button" disabled={start.isPending} onClick={() => start.mutate()} className={PRIMARY}>{failure ? "Get a new code" : "Get a code"}</button>
        <div className="mt-3 flex w-full justify-end"><button type="button" onClick={onClose} className={QUIET}>Close</button></div>
      </>
    )
  }
  return (
    <>
      <p className={NOTE}>Enter a code on GitHub to connect Frizz.</p>
      <div className={CODE_SLOT}><Waiting label="Getting a code…" /></div>
      <button type="button" disabled className={PRIMARY}>Copy code and open GitHub<ArrowUpRight size={14} aria-hidden="true" /></button>
      <div className="mt-3 flex w-full justify-end"><button type="button" onClick={onClose} className={QUIET}>Close</button></div>
    </>
  )
}

function DeviceCode({ code, url, onCancel }: { code: string; url: string; onCancel: () => void }) {
  const { copied, copy } = useCopyCode(code)
  const [opened, setOpened] = useState(false)
  return (
    <>
      {copied ? (
        <p className={`${NOTE} inline-flex items-center gap-1.5 text-success`}><Check size={13} aria-hidden="true" />Code copied. Paste it on GitHub.</p>
      ) : (
        <p className={NOTE}>Enter this code on GitHub to connect Frizz.</p>
      )}
      {/* Three columns, so the CODE is what is centred and the copy button hangs off its right. */}
      <div data-github-device-code className="my-[18px] grid min-h-[32px] w-full grid-cols-[1fr_auto_1fr] items-center gap-2">
        <span className="col-start-2 font-mono text-[30px] font-semibold leading-none tracking-[0.06em] text-fg">{code}</span>
        <button type="button" aria-label="Copy the code" onClick={() => void copy()} className="inline-flex size-7 items-center justify-center justify-self-start rounded-md text-muted outline-none hover:bg-hover-strong hover:text-fg focus-visible:ring-1 focus-visible:ring-border-strong">
          {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        </button>
      </div>
      <a href={url} target="_blank" rel="noreferrer" onClick={() => { void copy(); setOpened(true) }} className={PRIMARY}>
        {opened ? "Open GitHub again" : "Copy code and open GitHub"}
        <ArrowUpRight size={14} aria-hidden="true" />
      </a>
      <div className="mt-3 flex w-full items-center justify-between gap-3">
        <Waiting label="Waiting for GitHub…" />
        <button type="button" onClick={onCancel} className={QUIET}>Cancel</button>
      </div>
    </>
  )
}

function Waiting({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] text-muted">
      <Loader2 size={13} aria-hidden="true" className="animate-spin" />
      {label}
    </span>
  )
}
