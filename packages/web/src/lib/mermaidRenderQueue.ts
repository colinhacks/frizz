export interface MermaidRenderRequest {
  id: string
  source: string
  resolved: "light" | "dark"
  palette: Record<string, string>
}

export function createMermaidRenderQueue<Result>(
  render: (request: MermaidRenderRequest) => Promise<Result>,
  cleanup: (id: string) => void,
) {
  let tail: Promise<void> = Promise.resolve()

  function enqueue(request: MermaidRenderRequest): Promise<Result> {
    const captured = { ...request, palette: { ...request.palette } }
    const task = tail.then(async () => {
      try {
        return await render(captured)
      } finally {
        cleanup(captured.id)
      }
    })
    tail = task.then(() => undefined, () => undefined)
    return task
  }

  return { enqueue }
}
