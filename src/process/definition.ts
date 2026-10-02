import type { ProcessDefinition, ProcessStageDefinition, ProcessState, StageExecution } from './types'
export { PROCESS_INVENTORY as INVENTORIED_PROCESS } from '../generated/processInventory.ts'

export const PROCESS_STATE_LABELS: Record<ProcessState, string> = {
  notStarted: 'Not started',
  running: 'Running',
  waiting: 'Waiting',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  unknown: 'Unknown',
}

export const PROCESS_STATE_MARKS: Record<ProcessState, string> = {
  notStarted: '○', running: '▶', waiting: 'Ⅱ', succeeded: '✓',
  failed: '!', skipped: '↷', cancelled: '×', unknown: '?',
}

export const WALKTHROUGH_PROCESS: ProcessDefinition = {
  schemaVersion: 1,
  definitionId: 'help-email-inventory-v1',
  code: 'help-email',
  name: 'Help email · from intake to outcome',
  version: '1',
  coverageVersion: 'inventory-2026-10-02',
  mode: 'configuration',
  description: 'Read-only configuration inventory, 2 October 2026. Classify_Email runs before the handler. Dashed case-lifecycle routes describe conditional tracking, not inspected agent internals or proof of a run.',
  lanes: [
    { id: 'email', label: 'Email channel', order: 0 },
    { id: 'workflow', label: 'Workflow orchestration', order: 1 },
    { id: 'agents', label: 'Agents / tools', order: 2 },
    { id: 'cases', label: 'Case handling', order: 3 },
  ],
  stages: [
    { schemaVersion: 1, stageCode: 'intake', label: 'Email received', description: 'SharedMailboxOnNewEmailV2 on the Help mailbox. The canonical ProcessId is allocated at intake; mailbox sample counts are not execution counts.', laneId: 'email', phase: 'intake', kind: 'start', order: 0, coverage: 'unknown', optional: false, evidence: 'inventory', position: { x: 185, y: 28 } },
    { schemaVersion: 1, stageCode: 'classify', label: 'Classify email', description: 'Classify_Email invokes the inline classification definition before Classify_Email_Switch and before the servicing handler.', laneId: 'workflow', phase: 'classify', kind: 'task', order: 1, coverage: 'unknown', optional: false, evidence: 'inventory', position: { x: 420, y: 193 } },
    { schemaVersion: 1, stageCode: 'route', label: 'Classification?', description: 'Classify_Email_Switch selects Card Servicing or the default response. A configured branch does not mean that branch was executed.', laneId: 'workflow', phase: 'route', kind: 'gateway', order: 2, coverage: 'unknown', optional: false, evidence: 'inventory', position: { x: 655, y: 185 } },
    { schemaVersion: 1, stageCode: 'card-service', label: 'Card servicing agent', description: 'One opaque servicing invocation. Identification and tool actions may happen inside this agent; their order, identity outcome and individual timings are not instrumented. Expand details, not invented child spans.', laneId: 'agents', phase: 'act', kind: 'subprocess', order: 3, coverage: 'partial', optional: true, opaque: true, evidence: 'inventory', position: { x: 900, y: 358 } },
    { schemaVersion: 1, stageCode: 'default-response', label: 'Default response', description: 'The default SPAM_Response branch. Do not infer Mock_Response_Agent execution after the switch: branch Terminate actions mean its reachability is unconfirmed.', laneId: 'workflow', phase: 'act', kind: 'subprocess', order: 4, coverage: 'unknown', optional: true, opaque: true, evidence: 'inventory', position: { x: 900, y: 193 } },
    { schemaVersion: 1, stageCode: 'human-review', label: 'Human review', description: 'Conditional wait for explicitly linked blocking cases. Waiting time is not automated handling time. A reopened blocking case returns the process to waiting; unrelated open cases do not imply a handoff.', laneId: 'cases', phase: 'review', kind: 'wait', order: 5, coverage: 'unknown', optional: true, evidence: 'lifecycle', position: { x: 1160, y: 523 } },
    { schemaVersion: 1, stageCode: 'completed', label: 'Processing complete', description: 'Tracking outcome only when terminal policy and all linked blocking cases permit completion. Case completion alone is not evidence that unobserved agent operations succeeded.', laneId: 'workflow', phase: 'act', kind: 'end', order: 6, coverage: 'unknown', optional: true, evidence: 'lifecycle', position: { x: 1160, y: 193 } },
    { schemaVersion: 1, stageCode: 'exception', label: 'Exception recorded', description: 'An explicitly observed failure or cancellation. Missing data is unknown, never an exception inferred from absence.', laneId: 'agents', phase: 'act', kind: 'exception', order: 7, coverage: 'unknown', optional: true, evidence: 'lifecycle', position: { x: 1160, y: 358 } },
  ],
  transitions: [
    { schemaVersion: 1, transitionCode: 'received-classify', fromStageCode: 'intake', toStageCode: 'classify', label: 'Received', optional: false },
    { schemaVersion: 1, transitionCode: 'classified-route', fromStageCode: 'classify', toStageCode: 'route', label: 'Classification', optional: false },
    { schemaVersion: 1, transitionCode: 'route-card', fromStageCode: 'route', toStageCode: 'card-service', label: 'Card servicing', branchCode: 'card', optional: true },
    { schemaVersion: 1, transitionCode: 'route-default', fromStageCode: 'route', toStageCode: 'default-response', label: 'Default', branchCode: 'default', optional: true },
    { schemaVersion: 1, transitionCode: 'card-completed', fromStageCode: 'card-service', toStageCode: 'completed', label: 'No blocking case', optional: true },
    { schemaVersion: 1, transitionCode: 'default-completed', fromStageCode: 'default-response', toStageCode: 'completed', label: 'Finished', optional: true },
    { schemaVersion: 1, transitionCode: 'card-review', fromStageCode: 'card-service', toStageCode: 'human-review', label: 'Blocking case', optional: true },
    { schemaVersion: 1, transitionCode: 'card-exception', fromStageCode: 'card-service', toStageCode: 'exception', label: 'Failure', optional: true, kind: 'exception' },
    { schemaVersion: 1, transitionCode: 'review-completed', fromStageCode: 'human-review', toStageCode: 'completed', label: 'Blocking cases resolved', optional: true },
    { schemaVersion: 1, transitionCode: 'completed-reopened', fromStageCode: 'completed', toStageCode: 'human-review', label: 'Case reopened · wait', optional: true, kind: 'reopen' },
  ],
  sources: [{ name: 'Workflow configuration inventory', health: 'available', message: 'Configuration evidence dated 2 October 2026 only. Exact observation time is not reported. No execution ledger is connected.' }],
}

/** A retry supersedes only its own branch, never an independently active branch. */
export function latestBranchAttempts(executions: StageExecution[]): StageExecution[] {
  const branches = new Map<string, StageExecution>()
  for (const execution of executions) {
    const cases = execution.links.filter(link => link.kind === 'case' && link.recordId)
      .map(link => link.recordId).sort().join(',')
    const key = `${execution.parentExecutionId ?? ''}|${execution.branch ?? ''}|${cases}`
    const previous = branches.get(key)
    if (!previous || execution.attempt > previous.attempt ||
      (execution.attempt === previous.attempt && (execution.recordedAt ?? '') > (previous.recordedAt ?? ''))) branches.set(key, execution)
  }
  return [...branches.values()]
}

export function stageState(stage: ProcessStageDefinition, executions: StageExecution[]): ProcessState {
  const latest = latestBranchAttempts(executions.filter(item => item.stageCode === stage.stageCode))
  if (!latest.length) return 'unknown'
  for (const state of ['running', 'waiting', 'failed', 'unknown', 'cancelled', 'notStarted'] as const) {
    if (latest.some(item => item.state === state)) return state
  }
  return latest.every(item => item.state === 'skipped') ? 'skipped' : 'succeeded'
}

export function processTime(value?: string): string {
  if (!value) return 'Not reported'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Invalid timestamp' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}

export function processDuration(execution: StageExecution, waitingStage = false): string {
  if (waitingStage || execution.state === 'waiting') return 'Waiting span · not handling time'
  if (execution.durationMs === undefined || execution.durationProvenance === 'unknown') return 'Not measured'
  const seconds = execution.durationMs / 1000
  return `${seconds < 60 ? `${seconds.toFixed(1)} s` : `${(seconds / 60).toFixed(1)} min`} · ${execution.durationProvenance}`
}

export function legacyProcessEnabled(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('legacyProcess') === 'true'
}
