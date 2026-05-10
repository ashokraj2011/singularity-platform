// Mock runner — NEVER makes real external calls.
// Returns synthetic output based on tool action output schema shape.

export async function mockExecute(
  toolName: string,
  actionName: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Simulate a short processing delay
  await new Promise(resolve => setTimeout(resolve, 300))

  return {
    success: true,
    tool: toolName,
    action: actionName,
    executedAt: new Date().toISOString(),
    mockOutput: {
      message: `Mock execution of ${toolName}.${actionName} completed`,
      inputReceived: input,
      result: { id: `mock-${Date.now()}`, status: 'created' },
    },
  }
}
