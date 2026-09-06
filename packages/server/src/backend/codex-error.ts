import type { ProviderError } from "@frizz/shared"
import { redactCredentialSyntax } from "../credential-redaction.ts"

function errorText(text: string): string {
  const safe = redactCredentialSyntax(text)
    .replace(/\b((?:proxy-)?authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;"']+/gi, "$1[redacted]")
    .trim()
  return safe.length > 32_000 ? `${safe.slice(0, 32_000)}\n[truncated]` : safe
}

// Rollouts spell codes in snake_case; the app-server exposes the same enum in camelCase.
// Keep unknown categories and object variants instead of depending on an exhaustive provider enum.
export function codexProviderError(raw: unknown, at?: string, retrying = false): ProviderError {
  const error = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  const info = error.codex_error_info ?? error.codexErrorInfo
  const category = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined
  const code = category?.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().slice(0, 128)
  const message = typeof raw === "string" ? raw : typeof error.message === "string" ? error.message : ""
  const details = error.additional_details ?? error.additionalDetails
  return {
    message: errorText(message) || "Codex reported an error without a message.",
    ...(code ? { code } : {}),
    ...(typeof details === "string" && details.trim() ? { details: errorText(details) } : {}),
    ...(retrying ? { retrying: true } : {}),
    ...(at ? { at } : {}),
  }
}
