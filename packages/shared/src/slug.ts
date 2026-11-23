// The thread slug's length cap and the rule that turns a title into one. Apart from thread-slug.ts, whose
// zod contract would otherwise come along into the launcher with `slugify` (project-registry.ts).

export const THREAD_SLUG_MAX_CHARS = 200

// title -> slug matching the id regex in thread-slug.ts. Non-alnum collapses to a single '-'; leading/
// trailing '-' trimmed; empty falls back to "thread". Lives beside the contract it produces so both the
// dispatcher (which mints slugs from titles) and the registry (which recognises a slug a title
// produced) read the same rule — a second copy of this normalisation would drift.
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  // Leave no partial trailing separator after the cap. The dispatcher's collision suffixer preserves
  // this same bound when it appends -2, -3, … to a maximum-length base.
  return s.slice(0, THREAD_SLUG_MAX_CHARS).replace(/-+$/g, "") || "thread"
}
