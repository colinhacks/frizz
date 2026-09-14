export interface GithubLabelColors {
  foreground: string
  background: string
  border: string
}

const HEX = /^(?:#)?([0-9a-f]{6})$/i

function externalHue(color: string): string | undefined {
  const match = HEX.exec(color.trim())
  return match ? `#${match[1].toLowerCase()}` : undefined
}

// A label hue is external data, so light mode does not use it directly as ink. The document's
// light foreground keeps even white labels readable while the supplied hue remains in the tint.
// Dark retains the original hex ink and 0x26/0x59 fill/border alphas. CSS owns the inputs, so these
// expressions update on a live theme switch without a React subscription.
export function githubLabelColors(color: string): GithubLabelColors {
  const hue = externalHue(color) ?? "var(--color-muted)"
  return {
    foreground: `color-mix(in srgb, var(--color-fg) var(--gh-label-fg-mix), ${hue})`,
    background: `color-mix(in srgb, ${hue} var(--gh-label-bg-mix), var(--gh-label-bg-base))`,
    border: `color-mix(in srgb, ${hue} var(--gh-label-border-mix), var(--gh-label-border-base))`,
  }
}
