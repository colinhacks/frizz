export class RpcError extends Error {
  constructor(method: string, status: number, message: string)
  method: string
  status: number
}

/** Results are the unwrapped `result` of the JSON envelope, unchecked, so a caller narrows what it reads. */
export interface RpcClient {
  origin: string
  query(method: string, input?: unknown): Promise<unknown>
  mutate(method: string, input?: unknown): Promise<unknown>
  waitForHealth(timeoutMs?: number): Promise<boolean>
}

export function createRpcClient(baseUrl: string | URL, project?: string): RpcClient
