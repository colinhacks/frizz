import type { HTMLAttributes } from "react"
import { pauseWhileOffscreen } from "../lib/offscreenPause.ts"

export type LiveDotHue = "agent" | "shell" | "github"

/**
 * THE pulsing dot of a running sub-agent, shell or watch (`.frizz-live-dot`, styles.css). Every surface
 * draws it through here so that every copy pauses while it is scrolled out of view
 * (lib/offscreenPause.ts): a page full of dots below the fold otherwise costs a frame per vsync for as
 * long as it stays open.
 */
export function LiveDot({ hue, ...rest }: { hue: LiveDotHue } & Omit<HTMLAttributes<HTMLSpanElement>, "className" | "children">) {
  return <span ref={pauseWhileOffscreen} className={`frizz-live-dot frizz-live-dot--${hue}`} {...rest} />
}
