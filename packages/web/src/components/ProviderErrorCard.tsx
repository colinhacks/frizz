import { TriangleAlert } from "lucide-react"
import type { ProviderError, TranscriptMessage } from "@frizz/shared"
import { CARD_BODY, TranscriptCard } from "./TranscriptCard.tsx"

export function providerErrorVisible(messages: readonly TranscriptMessage[], error: ProviderError | undefined): boolean {
  return error !== undefined && messages.some((message) => message.providerError?.at === error.at
    && message.providerError?.message === error.message && message.providerError?.code === error.code)
}

export function ProviderErrorCard({ error }: { error: ProviderError }) {
  return (
    <TranscriptCard data-codex-error={error.code ?? "unknown"} tone={error.retrying ? "caution" : "danger"} icon={TriangleAlert} label={error.retrying ? "Codex retrying" : "Codex request failed"}>
      {error.code && <p className={`${CARD_BODY} font-mono [overflow-wrap:anywhere]`}>{error.code}</p>}
      <p className={`${CARD_BODY} whitespace-pre-wrap [overflow-wrap:anywhere]`}>{error.message}</p>
      {error.details && <p className={`${CARD_BODY} whitespace-pre-wrap [overflow-wrap:anywhere]`}>{error.details}</p>}
    </TranscriptCard>
  )
}
