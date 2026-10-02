export type ProcessState = 'notStarted' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'unknown'
export type ProcessCoverage = 'instrumented' | 'partial' | 'uninstrumented' | 'unknown'
export type ProcessDataMode = 'observed' | 'configuration' | 'synthetic'
export type ProcessSourceHealth = 'available' | 'stale' | 'unavailable' | 'unknown'
export type BusinessPhase = 'intake' | 'identify' | 'classify' | 'route' | 'act' | 'review'

export interface ProcessLink {
  kind: 'workflowDefinition' | 'workflowRun' | 'agentConversation' | 'contact' | 'holding' | 'case' | 'task' | 'note' | 'email'
  label: string
  recordId?: string
  /** Only a validated, allowlisted URL from the read gateway may be supplied. */
  url?: string
}

export interface ProcessSource {
  name: string
  health: ProcessSourceHealth
  observedAt?: string
  message?: string
}

export interface ProcessLane {
  id: string
  label: string
  order: number
}

export interface ProcessStageDefinition {
  schemaVersion: 1
  stageCode: string
  label: string
  description: string
  laneId: string
  phase: BusinessPhase
  kind: 'start' | 'task' | 'gateway' | 'subprocess' | 'wait' | 'end' | 'exception'
  order: number
  coverage: ProcessCoverage
  optional: boolean
  /** Outer invocation is known; no child spans or identity/action timings are inferred. */
  opaque?: boolean
  /** Lifecycle overlays are not claims about inspected workflow actions. */
  evidence?: 'inventory' | 'lifecycle' | 'synthetic'
  position?: { x: number; y: number }
}

export interface ProcessTransition {
  schemaVersion: 1
  transitionCode: string
  fromStageCode: string
  toStageCode: string
  label: string
  branchCode?: string
  optional: boolean
  kind?: 'sequence' | 'exception' | 'reopen'
}

export interface ProcessDefinition {
  schemaVersion: 1
  definitionId: string
  code: string
  name: string
  version: string
  coverageVersion: string
  mode: ProcessDataMode
  description: string
  lanes: ProcessLane[]
  stages: ProcessStageDefinition[]
  transitions: ProcessTransition[]
  sources: ProcessSource[]
}

export interface StageExecution {
  schemaVersion: 1
  stageExecutionId: string
  processId: string
  stageCode: string
  attempt: number
  state: ProcessState
  parentExecutionId?: string
  branch?: string
  source: string
  sourceVersion?: string
  occurredAt?: string
  recordedAt?: string
  startedAt?: string
  endedAt?: string
  durationMs?: number
  durationProvenance: 'reported' | 'derived' | 'unknown'
  links: ProcessLink[]
  errorCode?: string
}

export interface ProcessEvent {
  schemaVersion: 1
  eventId: string
  processId: string
  stageExecutionId?: string
  stageCode?: string
  transitionCode?: string
  eventType: string
  outcome?: string
  source: string
  sourceVersion?: string
  occurredAt?: string
  recordedAt: string
  projectionRevision: number
  links: ProcessLink[]
}

export interface ProcessCase {
  caseId: string
  role: string
  blocksCompletion: boolean
  linkedAt?: string
  state: string
  links: ProcessLink[]
}

export interface ProcessSummary {
  schemaVersion: 1
  /** Canonical full intake UUID; never a subject, email address or draft ID. */
  processId: string
  definitionId: string
  definitionVersion: string
  coverageVersion: string
  state: ProcessState
  mode: ProcessDataMode
  receivedAt?: string
  latestEventAt?: string
  projectionRevision: number
  coverage: ProcessCoverage
  sourceHealth: ProcessSourceHealth
}

export interface ProcessSnapshot extends ProcessSummary {
  definition?: ProcessDefinition
  fetchedAt: string
  stages: StageExecution[]
  sources: ProcessSource[]
  links: ProcessLink[]
  cases: ProcessCase[]
}

export interface ProcessEventPage {
  schemaVersion: 1
  processId: string
  events: ProcessEvent[]
  nextCursor?: string
}

export interface ProcessReadGateway {
  loadProcessDefinitions(): Promise<ProcessDefinition[]>
  listProcesses(): Promise<ProcessSummary[]>
  getProcessState(processId: string): Promise<ProcessSnapshot>
  getProcessEvents(processId: string, cursor?: string): Promise<ProcessEventPage>
}

export interface ProcessFixture {
  id: string
  label: string
  description: string
  definition: ProcessDefinition
  snapshot: ProcessSnapshot
  eventPage: ProcessEventPage
}
