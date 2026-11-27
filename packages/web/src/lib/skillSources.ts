// Where the `/` menu's list comes from (components/SlashTypeahead.tsx), one fetcher per kind of box.

import type { Backend, ThreadSkill } from "@frizz/shared"
import { rpc, rpcFor } from "../api/rpc.ts"

// A thread's list: its live session's, cached per thread and shared by every box on that thread (the
// prompt box on each surface, the Goal's text), so opening any of them only ever asks the harness once.
// A failure is NOT cached: the common failure is "the session is not running yet", and the next `/`
// should ask again once it is. Module scope on purpose — the cache outlives any one composer mount.
const threadSkillsCache = new Map<string, Promise<ThreadSkill[]>>()
export function fetchThreadSkills(slug: string): Promise<ThreadSkill[]> {
  const cached = threadSkillsCache.get(slug)
  if (cached) return cached
  const fetched = rpc.threadSkills({ slug }).then(
    (result) => result.skills,
    () => {
      threadSkillsCache.delete(slug)
      return []
    },
  )
  threadSkillsCache.set(slug, fetched)
  return fetched
}

// THE NEW-THREAD BOX'S `/` MENU (colinhacks/frizz#79). A thread's box asks its live session; this box has
// no thread yet, so it asks the server what a new thread of the agent its model chip picks would get in
// this project: Claude's skills probe, a session started the way a worker is, and Codex's and OpenCode's
// skill lists for the project's directory. Antigravity and ACP agents list commands only for a live
// session, so for them the box offers nothing rather than another thread's list, which could name what
// this agent does not have.
//
// Cached per project and agent for a short while, so reopening the dialog does not ask again. A failure
// is not cached and reads as "no suggestions", as the thread menu's does.
const DISPATCH_SKILLS_FRESH_MS = 15_000
const dispatchSkillsCache = new Map<string, { at: number; skills: Promise<ThreadSkill[]> }>()
export function fetchDispatchSkills(project: string | undefined, backend: Backend): Promise<ThreadSkill[]> {
  const key = `${project ?? ""}\n${backend}`
  const cached = dispatchSkillsCache.get(key)
  if (cached && Date.now() - cached.at < DISPATCH_SKILLS_FRESH_MS) return cached.skills
  const skills: Promise<ThreadSkill[]> = rpcFor(project).threadSkills({ backend }).then(
    (result) => result.skills,
    () => {
      if (dispatchSkillsCache.get(key)?.skills === skills) dispatchSkillsCache.delete(key)
      return []
    },
  )
  dispatchSkillsCache.set(key, { at: Date.now(), skills })
  return skills
}
