---
title: Frizz light-mode architecture
description: A two-theme design with browser-local preferences, flash-free startup, and explicit renderer adapters.
tags: [design, web, themes]
---

# Frizz light-mode architecture

Status: proposed architecture, not implemented. Written 2026-09-11 against `e330dbd1`. This is a design record under the [plans archive convention](./README.md).

## Decision

Frizz gets one interface with two color palettes. Components keep semantic names such as `bg-panel` and `text-muted`. The document root selects the palette. Theme selection must not reload the page, reconnect a terminal, or reset a transcript.

The preference offers **System**, **Light**, and **Dark**. It belongs to this browser, across every project on the same Frizz origin. New and existing browsers without an explicit choice use System. This deliberately permits a light OS setting to change the appearance on upgrade. Explicit Dark remains available. There is no per-project override, server setting, account sync, or automatic time-of-day schedule.

The proposed data model separates intent from appearance:

```ts
type ThemePreference = "system" | "light" | "dark"
type ResolvedTheme = "light" | "dark"
```

Only the preference is persistent. The resolved theme is derived from the preference and the OS media query. A corrupt stored value resolves as System.

## Why this fits Frizz

The existing [stylesheet](../packages/web/src/styles.css) already defines shared background, panel, text, status, and code tokens at lines 20-64. Both highlight.js and the diff scanner consume the code palette. A second set of values is smaller than a second set of components.

The [view preferences module](../packages/web/src/lib/prefs.ts) already separates local rendering choices from server dispatch settings. Theme follows that ownership. [Server settings](../packages/server/src/settings.ts), lines 10-31, place font and project-rail choices at machine scope to avoid conflicting project values. Browser-local theme has no conflicting project value and needs no server authority. The [font module](../packages/web/src/lib/font.ts) demonstrates a first-paint cache, but its RPC reconciliation is not the theme model.

The [HTML entry point](../packages/web/index.html) hard-codes a dark canvas before the CSS arrives. Its comment documents that project switching is a full document navigation. Replacing only the main stylesheet would leave a dark flash on every light-mode project switch.

## Alternatives

| Approach | Tradeoff | Decision |
| --- | --- | --- |
| Root-selected semantic CSS variables | Reuses existing components and requires explicit treatment of non-CSS renderers | Chosen |
| Light classes plus `dark:` variants at each call site | Repeats theme decisions across cards, overlays, and transcripts | Rejected |
| Invert the rendered page | Changes screenshots, provider art, syntax colors, and status meaning | Rejected |
| Server-wide preference | Makes different browsers share one appearance and delays first-paint resolution | Rejected |
| Keep every rich renderer dark | Reduces migration work but leaves large dark blocks throughout light mode | Rejected |

## Scope

The feature includes the project grid, desktop and mobile boards, thread drawers and fullscreen threads, settings, dialogs, questions, code, diffs, GitHub cards, login terminal, Mermaid diagrams, embedded visualization host, and supervisor recovery pages.

Source screenshots, videos, downloaded documents, remote pages, and user-authored colors are content. Frizz does not recolor their pixels. Installed-app launch artwork is also distinct from the document's live theme.

## Preference and first-paint contract

A new `packages/web/src/lib/theme.ts` owns parsing, resolution, application, and subscriptions. Its public operations are `getThemeSnapshot()`, `setThemePreference()`, `subscribeTheme()`, and `initTheme()`. React reads a stable snapshot through `useSyncExternalStore`. Only renderer adapters subscribe to resolved-theme changes. Ordinary components use CSS.

Persist the validated preference at `localStorage["frizz-theme"]`. This is a dedicated key, not another field inside `frizz.prefs.v1`. The existing [preferences writer](../packages/web/src/lib/prefs.ts) writes its entire blob on change. A dedicated key prevents a density change in a stale tab from overwriting the theme. It follows the same browser-local ownership without changing every existing preference's synchronization.

| Event | Result |
| --- | --- |
| Missing or invalid value | Resolve System from `prefers-color-scheme: dark` |
| Explicit Light or Dark | Ignore OS changes |
| OS changes while System is selected | Apply the new resolved theme without persistence |
| User changes preference | Apply immediately, notify subscribers, then attempt persistence |
| Another tab changes or removes the theme key | Read and apply the new preference without writing it back |
| Storage access fails | Keep the selection in memory for this document |
| No media-query API | Resolve System as Light |
| Project navigation or reload | Run the same pre-paint resolution on the next document |

The storage listener also handles `localStorage.clear()`, whose event key is null. It must not reread storage during every OS event or erase a session-only choice after a failed write. Initialization is idempotent and releases listeners during HMR disposal.

Add an **Appearance** field before Font in [SettingsDrawer](../packages/web/src/components/SettingsDrawer.tsx), with the existing bordered Select and sentence-case options System, Light, and Dark. Help text reads "Applies to this browser across all projects. System follows the device appearance." The control does not use the server-settings draft or save status. Keep it usable while server settings are loading or unavailable.

In [index.html](../packages/web/index.html), replace the fixed dark flash guard with two small inline canvas rules and a synchronous script before the body. The script reads the dedicated key, resolves the OS preference, sets `html[data-theme="light"|"dark"]`, and updates `color-scheme` and `theme-color`. Inline CSS paints the selected canvas before the bundle arrives. An OS-aware CSS fallback handles unavailable JavaScript or storage. `initTheme()` runs before React mounts in [main.tsx](../packages/web/src/main.tsx) and adopts the same decision.

Keep the two startup canvas literals and the small resolver inline rather than adding a network dependency. A table-driven test executes the actual inline script and the runtime resolver against the same inputs. A palette-parity test checks the inline background values against CSS. This is deliberate, bounded duplication like the existing font guard, not a second theme implementation.

## Token ownership and visual direction

Keep the current dark values unchanged initially. Put both complete palettes in a new `packages/web/src/theme.css`, imported by [styles.css](../packages/web/src/styles.css). Keep typography, radii, breakpoints, and motion in the current stylesheet. Preserve Tailwind's existing semantic utility names.

CSS is the palette authority. Define the complete dark token set in `@theme static` so production CSS retains tokens read only by JavaScript and override every theme-dependent token under `:root[data-theme="light"]`. Add an OS-light fallback selector only when `data-theme` is absent. Theme adapters read computed CSS values after the root changes. They do not import independent RGB tables. Verify that compiled Tailwind utilities and arbitrary-value opacity modifiers resolve the selected values.

The light palette uses a cool off-white page, white panels, darker separators, and dark neutral text. It preserves Frizz's restrained density and yellow attention identity. It is not a new layout or a warm paper theme. Final numeric colors require rendered contrast and optical measurements during implementation.

Several existing tokens need distinct roles rather than literal inversion:

| Role | Contract |
| --- | --- |
| Base and panels | Separate the page, card, inset, and elevated layers in both palettes |
| Text | Main, muted, and faint text remain distinct and readable on each supported parent |
| Accent | Split foreground ink, solid fill, and on-accent text so yellow marks and buttons need not share one shade |
| User messages | Pair `user-bubble` with `user-bubble-fg`, not an accidental `text-bg` inverse |
| Status | Preserve attention yellow, live green, shell blue, and watch violet as meanings with theme-specific luminance |
| Interaction | Tokenize hover, selection, focus ring, scrollbar, and backdrop values |
| Code and diffs | Add base-code text, additions, deletions, signs, line numbers, and line backgrounds beside the existing `--code-*` tokens |
| GitHub | Separate Primer foreground, emphasis fill, on-emphasis text, and neutral border tokens |
| Rich renderers | Provide terminal colors and visualization series colors from the same palette |

Migration is by meaning, not a global black-to-white replacement. For example, the literal white hover overlays in [Sidebar](../packages/web/src/components/Sidebar.tsx) and [MobileBoard](../packages/web/src/components/MobileBoard.tsx) become hover tokens. The black modal scrim remains a dimming treatment with a theme-specific alpha. Black or white inside an SVG mask is mask data and stays unchanged.

Audit opacity too. `text-muted/60` can fail on white even when the opaque muted token passes. Every `bg-accent` consumer must choose an explicit foreground. The hard-coded background in [BackgroundShellSheet](../packages/web/src/components/BackgroundShellSheet.tsx) becomes an inset token.

## Renderer contracts

### GitHub marks and labels

[primer.ts](../packages/web/src/lib/primer.ts) intentionally centralizes GitHub's measured dark colors and distinguishes bare marks from emphasis fills. Keep that vocabulary and its public property names. Change the values to references such as `var(--gh-fg-success)`, with measured Primer light and dark values in the palette. Update its dark-only guidance.

Inspect every consumer. [GithubRefCardBody](../packages/web/src/components/GithubRefCardBody.tsx), line 113, appends `33` to a hex value. That is invalid after switching to a CSS variable. Replace the composition with an explicit neutral-fill token or `color-mix`. Convert `PRIMER_DANGER_LINK` too. State pills retain an explicit on-emphasis color rather than generic page text.

GitHub label colors are external data. Keep their hue identity but derive accessible foreground, tinted background, and border treatments for each theme. Cover pale yellow, white, near-black, and malformed colors. Do not replace every GitHub hue with Frizz's accent.

### Code and diffs

Keep both existing highlighting engines. [diff.css](../packages/web/src/lib/diff/diff.css), lines 39-73, has literal additions, deletions, and gutter colors. [styles.css](../packages/web/src/styles.css), around lines 1222-1309, also has literal base-code and diff colors. Tokenize those along with the existing syntax palette. CSS changes should repaint existing code without reparsing or rebuilding the transcript.

### Terminal

[TerminalPane](../packages/web/src/components/TerminalPane.tsx), line 40, initializes xterm with fixed background and foreground colors. Apply a complete palette through `term.options.theme`, including cursor, selection, ANSI colors, and bright ANSI colors. Subscribe after creating the terminal and unsubscribe before disposal.

The terminal stays mounted. Do not add theme to the effect that owns the WebSocket and terminal instance. Preserve buffer, scrollback, selection, focus, and connection across a switch. Remove the fixed dark login-terminal wrapper in [SignInModal](../packages/web/src/components/SignInModal.tsx).

Explicit true-color output from a process remains process-owned. Frizz themes xterm's default and indexed colors but does not rewrite terminal bytes.

### Mermaid

[CodexRichOutput](../packages/web/src/components/CodexRichOutput.tsx), lines 171-232, initializes one Mermaid module with a fixed dark configuration and renders only when source changes. CSS cannot reliably repaint its generated styles.

Keep the cached module import. Put configuration and rendering inside one serialized adapter operation. Each request captures source and the resolved palette. The adapter initializes a customizable base theme with concrete computed colors, then awaits that request's render before another configuration can run. Preserve strict security and the source-size bound.

A theme change schedules a new render. A generation identifier prevents older requests from committing after a newer theme or source change. Use unique render IDs, retain the previous successful diagram until replacement is ready, and preserve scratch-node cleanup on success, error, and unmount. A rejected job must not stall later jobs. Do not remount the surrounding message.

### Embedded visualizations

[ChatView](../packages/web/src/components/ChatView.tsx), lines 3625-3711, already maps Frizz tokens into an iframe message. It sends that message only on load. [local-visualization.ts](../packages/server/src/local-visualization.ts), lines 75-123, supplies dark defaults and chart-series colors that the current message does not replace.

Extend the token map to include destructive and chart-series colors. Send the complete resolved palette on iframe readiness and on theme changes, without changing `src` or remounting. Add a ready/applied acknowledgement so the parent can keep the initial frame visually hidden until its first palette is applied. If no acknowledgement arrives within 5s after iframe load, display the existing unavailable state rather than an indefinitely hidden frame. Cancel the timer on acknowledgement or unmount.

Keep `sandbox="allow-scripts"`, the opaque origin, CSP, and height bounds. Check the iframe window on parent messages and `event.source === parent` inside the iframe. The bridge carries appearance only, not control authority. Theme application triggers the existing height measurement and a theme-change notification for cooperative canvas renderers.

CSS-token-based HTML updates live. Arbitrary authored CSS or canvas pixels that ignore the bridge cannot be recolored safely. This is a content limitation, not a reason to reload an interactive visualization or relax its sandbox.

### Recovery and installed-app chrome

[supervisor-pages.ts](../packages/server/src/supervisor-pages.ts), lines 1-20 and 261-284, requires fully inline pages because the web bundle may be unavailable. Its anonymous refusal page must not reveal the product, even in script identifiers or storage keys.

Branded recovery pages get the same small pre-paint preference resolver and both inline palette subsets. They cannot fetch web assets. Anonymous refusal pages use only an unbranded OS-aware palette and never read `frizz-theme`. Preserve the existing no-disclosure tests. Add parity checks for the shared palette subset and actual inline scripts.

The document's `theme-color` follows the resolved theme. The static [web manifest](../packages/web/public/manifest.webmanifest) and install icons remain fixed launch metadata in this version. An installed app can show the existing dark splash before the themed document loads. Do not promise to synchronize an OS-managed splash through a runtime meta tag.

## Delivery sequence and checks

These are implementation units, not changes made by this plan.

1. Add the preference model, first-paint resolver, palette file, and parity tests. Exercise the new resolver in tests, but do not enable it in production startup yet. Preserve the dark production default until all renderers support both modes.
2. Migrate ordinary UI, semantic foreground pairs, code, diffs, and GitHub colors. Compare dark screenshots to the current build. Recheck translucent text and overlays against their actual parent backgrounds.
3. Add live xterm, Mermaid, and visualization adapters. Prove state preservation with a running terminal, concurrent diagram renders, and an interactive iframe.
4. Theme inline recovery pages, activate the new startup resolver, and add the Appearance control together. Exercise real navigation, server recovery, and installed-window document chrome.
5. Run the acceptance matrix, inspect screenshots, fix failures, and land the complete feature on local main. Do not expose a partially working Light option between units.

The acceptance matrix includes:

- Fresh, persisted Light, persisted Dark, System, invalid storage, denied storage, and storage removal.
- Live OS changes, cross-tab changes, reload, project navigation, grid entry, deep-linked thread, and recovery navigation.
- Slow bundle loading with the first visible canvas already correct. Extend the frame-sampling approach in [App.firstPaint.e2e.test.ts](../packages/web/src/App.firstPaint.e2e.test.ts), including a negative control that visibly detects a deliberately delayed palette.
- Desktop and phone widths, both sans and mono fonts, both palettes, and native controls.
- Rested, Active, Snoozed, and Done rows, question options, menus, tooltips, dialogs, errors, selected text, disabled controls, focus rings, code, and diffs.
- Terminal connection-count and buffer assertions across a theme switch. Include a real login-terminal flow.
- Simultaneous Mermaid diagrams with rapid theme changes, malformed sources, and an unmount during rendering.
- An iframe control whose value survives theme changes. Check its first paint, chart colors, height updates, and unchanged sandbox.
- Recovery while web assets are unavailable, plus anonymous-response no-disclosure assertions.

Set acceptance targets of at least 4.5:1 for normal readable text and 3:1 for large text and meaningful control boundaries or marks. Measure composited colors, not only token pairs. Do not use color alone for statuses. Code comments, line numbers, and secondary labels need explicit review rather than a blanket "muted" exemption.

The UI gate uses the project's headless-browser, visual-review, and optical-spacing skills. Inspect cropped screenshots and measure both ink axes in both fonts. Record console errors and owned-browser cleanup. The inline recovery path also requires the promoted-artifact verification skill because development CSS is not evidence that the shipped launcher page works.

Run `nub run typecheck`, the web build via `nub run build` in `packages/web`, focused theme and adapter tests, and the relevant real-browser checks. Run the exact checks recorded in [ci.yml](../.github/workflows/ci.yml): board tests, portable-monitor synchronization, and monitor tests, through Nub. [release.yml](../.github/workflows/release.yml) separately gates on typechecking. Broad test-suite failures must be reported rather than relabeled as light-mode verification.

## Design review

The smallest viable design is a root attribute, two CSS palettes, one browser-local preference owner, and adapters only where CSS cannot reach. A React provider carrying raw color values would add rerenders without helping normal components.

Model the Domain separated saved preference from resolved appearance. Laziness Protocol kept the existing semantic utility names and highlighting engines, rejected a new theme framework, and limited duplicated bootstrap logic to code that must run without the bundle. These are the Poteto principles applied here.

The expensive failure cases are covered by explicit contracts. A root-only palette misses startup and recovery pages. Hex-to-variable replacement breaks alpha concatenation. A theme dependency on the terminal mount effect reconnects the session. Concurrent Mermaid initialization applies the wrong palette. Reloading an iframe loses its interaction state. The delivery checks target those failures.

No product decision blocks this architecture. Exact palette values are implementation measurements within the stated visual direction. This planning task does not implement or visually validate light mode.
