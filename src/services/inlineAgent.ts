import type { AgentNodeResult } from '../generated/models/AgentsModel'
import type { IOperationResult } from '@microsoft/power-apps/data'

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function normalized(value: AgentNodeResult | undefined): AgentNodeResult | undefined {
  if (!value || !isRecord(value) || value.message) return value
  const result = text(value.result)
  return result ? { ...value, message: result } : value
}

function data(result: IOperationResult<AgentNodeResult>, operation: string): AgentNodeResult | undefined {
  if (!result.success) throw new Error(`${operation}: ${result.error?.message || 'the connector reported a failure.'}`)
  return normalized(result.data)
}

function conversationId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('conversationId' in value)) return undefined
  const id = value.conversationId
  if (typeof id !== 'string' || !CONVERSATION_ID.test(id)) throw new Error('The AI connector returned an invalid conversation ID.')
  return id
}

function hasOutput(value: AgentNodeResult | undefined): value is AgentNodeResult {
  return value !== undefined && value !== null
    && ((value.structuredOutput !== undefined && value.structuredOutput !== null)
      || (typeof value.message === 'string' && value.message.trim().length > 0))
}

const TIMEOUT_MESSAGE = 'AI generation did not finish within two minutes. Nothing was sent. The agent may still finish; wait before starting another request.'

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: number | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), Math.max(0, deadline - performance.now()))
      }),
    ])
  } finally {
    window.clearTimeout(timer)
  }
}

export interface InlineAgentOperations {
  invoke: () => Promise<IOperationResult<AgentNodeResult>>
  getConversation: (id: string) => Promise<IOperationResult<AgentNodeResult>>
  timeoutMs?: number
  pollIntervalMs?: number
}

export async function runInlineAgent(operations: InlineAgentOperations): Promise<AgentNodeResult> {
  const deadline = performance.now() + (operations.timeoutMs ?? 120_000)
  const initial = data(await beforeDeadline(operations.invoke(), deadline), 'AI generation could not start')
  if (hasOutput(initial)) return initial
  const id = conversationId(initial)
  if (!id) throw new Error('The AI connector returned neither a draft nor a conversation to await.')
  const interval = operations.pollIntervalMs ?? 5000
  while (performance.now() < deadline) {
    await new Promise<void>(resolve => window.setTimeout(resolve, Math.min(interval, Math.max(0, deadline - performance.now()))))
    if (performance.now() >= deadline) break
    const result = data(await beforeDeadline(operations.getConversation(id), deadline), 'AI generation failed while waiting for its result')
    const returnedId = conversationId(result)
    if (returnedId && returnedId.toLowerCase() !== id.toLowerCase()) throw new Error('The AI connector returned a different conversation; generation was stopped.')
    if (hasOutput(result)) return result
  }
  throw new Error(TIMEOUT_MESSAGE)
}
