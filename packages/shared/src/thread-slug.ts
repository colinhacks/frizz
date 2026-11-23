import { z } from "zod"
import { THREAD_SLUG_MAX_CHARS } from "./slug.ts"

export { slugify, THREAD_SLUG_MAX_CHARS } from "./slug.ts"

// One identifier contract for every thread-bearing boundary. Keeping this deliberately narrower
// than a filesystem basename also makes the value safe as a process identity string, an environment
// value, and a literal path segment without relying on shell escaping or platform-specific filename
// rules.
export const ThreadSlug = z.string()
  .min(1)
  .max(THREAD_SLUG_MAX_CHARS)
  .regex(/^[a-z0-9][a-z0-9-]*$/)
export type ThreadSlug = z.infer<typeof ThreadSlug>

