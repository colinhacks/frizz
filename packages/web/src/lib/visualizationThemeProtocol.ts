export interface VisualizationThemeMessage {
  type: "frizz-inline-vis-theme"
  requestId: number
  colorScheme: "light" | "dark"
  vars: Record<string, string>
}

export function visualizationThemeMessage(requestId: number, colorScheme: "light" | "dark", vars: Record<string, string>): VisualizationThemeMessage {
  return { type: "frizz-inline-vis-theme", requestId, colorScheme, vars }
}

export function isVisualizationThemeAck(data: unknown, requestId: number): boolean {
  return typeof data === "object" && data !== null
    && (data as { type?: unknown }).type === "frizz-inline-vis-applied"
    && (data as { requestId?: unknown }).requestId === requestId
}
