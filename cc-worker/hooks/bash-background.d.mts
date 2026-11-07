export const BACKGROUND_JOB_REFUSAL: string
export function hasEscapingBackgroundJob(raw: unknown): boolean
export function evaluateBashBackgroundHook(
  input: unknown,
  env?: Record<string, string | undefined>,
): Record<string, unknown>
export function isDirectHookExecution(argv1: unknown, moduleUrl: string, realpath?: (path: string) => string): boolean
