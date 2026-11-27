// WHICH PROJECT ICONS THIS BROWSER HAS ALREADY DRAWN — so a square that mounts again draws its icon
// at once instead of fading it in.
//
// A square starts transparent and fades its icon in on `load`, which is right the first time a picture
// arrives and wrong every time after: the grid remounts every square when it is opened, and a reload
// remounts all of them, so a picture the browser held in its cache still took ~120ms to show (the load
// event, then the 150ms fade), measured 2026-10-21 on a 12-project grid. Remembering it here lets the
// square skip both, and the browser paints the cached picture in the first frame it can.
//
// Keyed by project id and `iconVersion`, which is the picture's hash, so a changed icon is a new key
// and fades in like any new picture. The value is whether the picture fills its tile (ProjectSquare's
// `fills`), so a remembered square starts with the right fit too, instead of jumping on load.
// Kept in localStorage so it outlives a reload, and capped so it cannot grow without bound.

// `-v2`: the fit rule changed (lib/projectIconFit.ts), so a transparent mark remembered as filling
// would draw cropped for a frame before its load corrected it.
const KEY = "frizz-project-icons-seen-v2"
const LIMIT = 200

let seen: Map<string, boolean> | undefined

function load(): Map<string, boolean> {
  if (seen) return seen
  seen = new Map()
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>
    for (const [key, fills] of Object.entries(stored)) if (typeof fills === "boolean") seen.set(key, fills)
    // The key before `-v2`, which nothing reads any more.
    localStorage.removeItem("frizz-project-icons-seen")
  } catch {
    // Unreadable or absent: every square fades in once, as it always did.
  }
  return seen
}

/** The key a project's CURRENT icon is remembered by. */
export function projectIconKey(project: { id: string; iconVersion?: string }): string {
  return `${project.id}:${project.iconVersion ?? ""}`
}

/** Whether this picture has been drawn here before, and if so whether it fills its tile. */
export function seenProjectIcon(key: string): boolean | undefined {
  return load().get(key)
}

export function rememberProjectIcon(key: string, fills: boolean): void {
  const map = load()
  if (map.get(key) === fills) return
  map.delete(key)
  map.set(key, fills)
  // Oldest first, so the ones past the limit are the ones not drawn for longest.
  while (map.size > LIMIT) map.delete(map.keys().next().value!)
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(map)))
  } catch {
    // Storage full or off: remembered for this page only.
  }
}
