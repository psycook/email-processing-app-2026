import type {
  BusinessPhase, ProcessCase, ProcessCoverage, ProcessDefinition, ProcessEvent, ProcessEventPage,
  ProcessLink, ProcessReadGateway, ProcessSnapshot, ProcessSourceHealth, ProcessState, ProcessSummary, StageExecution,
} from '../process/types'

export type ProcessReadAction = 'rfd_GetProcessDefinitions' | 'rfd_ListEmailProcesses'
  | 'rfd_GetEmailProcessState' | 'rfd_GetEmailProcessEvents'
export type ProcessReadTransport = (action: ProcessReadAction, request: Record<string, unknown>) => Promise<unknown>
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PAGES = 20

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Process service returned an invalid object.')
  return value as Record<string, unknown>
}
function string(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Process service returned invalid ${key}.`)
  return value
}
function optionalString(row: Record<string, unknown>, key: string): string | undefined {
  return row[key] === undefined || row[key] === null ? undefined : string(row, key)
}
function id(row: Record<string, unknown>, key: string): string {
  const value = string(row, key)
  if (!GUID.test(value)) throw new Error(`Process service returned invalid ${key}.`)
  return value.toLowerCase()
}
function optionalId(row: Record<string, unknown>, key: string): string | undefined {
  return row[key] === undefined || row[key] === null ? undefined : id(row, key)
}
function integer(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Process service returned invalid ${key}.`)
  return value
}
function boolean(row: Record<string, unknown>, key: string): boolean {
  if (typeof row[key] !== 'boolean') throw new Error(`Process service returned invalid ${key}.`)
  return row[key]
}
function date(row: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(row, key)
  if (value !== undefined && !Number.isFinite(Date.parse(value))) throw new Error(`Process service returned invalid ${key}.`)
  return value
}
function requiredDate(row: Record<string, unknown>, key: string): string {
  const value = date(row, key)
  if (value === undefined) throw new Error(`Process service omitted required ${key}.`)
  return value
}
function rows(row: Record<string, unknown>, key: string): Record<string, unknown>[] {
  if (!Array.isArray(row[key])) throw new Error(`Process service returned invalid ${key}.`)
  return row[key].map(record)
}
function envelope(value: unknown): Record<string, unknown> {
  const result = record(value)
  if (result.schemaVersion !== 1) throw new Error('Unsupported process-service schema version.')
  return result
}
function member<T extends string>(value: string, values: readonly T[], field: string): T {
  const result = values.find(item => item === value)
  if (!result) throw new Error(`Process service returned unsupported ${field}.`)
  return result
}
function coverage(value: string): ProcessCoverage {
  return value === 'observed' ? 'instrumented' : value === 'opaque' ? 'uninstrumented'
    : member(value, ['instrumented', 'partial', 'uninstrumented', 'unknown'], 'coverage')
}
function processState(value: string): ProcessState {
  switch (value) {
    case 'received': case 'processing': return 'running'
    case 'waiting-review': return 'waiting'
    case 'completed': return 'succeeded'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    case 'needs-reconciliation': return 'unknown'
    default: throw new Error('Process service returned an unsupported process state.')
  }
}
function health(value: string): ProcessSourceHealth {
  switch (value) {
    case 'current': case 'healthy': case 'available': return 'available'
    case 'partial': case 'stale': case 'degraded': case 'reconciliation-required': return 'stale'
    case 'unavailable': return 'unavailable'
    case 'unknown': return 'unknown'
    default: throw new Error('Process service returned unsupported health.')
  }
}
function links(row: Record<string, unknown>, organizationUrl?: string): ProcessLink[] {
  const mapping: [string, ProcessLink['kind'], string][] = [
    ['caseId', 'case', 'Case'], ['contactId', 'contact', 'Contact'], ['holdingId', 'holding', 'Financial holding'],
    ['emailId', 'email', 'Email activity'], ['taskId', 'task', 'Task'], ['noteId', 'note', 'Note'],
    ['workflowId', 'workflowDefinition', 'Workflow definition'],
  ]
  return mapping.flatMap(([field, kind, label]) => {
    const recordId = optionalId(row, field)
    const entities: Partial<Record<ProcessLink['kind'], string>> = {
      case: 'incident', contact: 'contact', holding: 'rfd_financialaccount',
      email: 'email', task: 'task', note: 'annotation',
      workflowDefinition: 'workflow',
    }
    if (!recordId) return []
    let url: string | undefined
    if (organizationUrl) {
      const target = new URL('/main.aspx', organizationUrl)
      target.searchParams.set('pagetype', 'entityrecord')
      target.searchParams.set('etn', entities[kind] ?? '')
      target.searchParams.set('id', recordId)
      url = target.href
    }
    const result: ProcessLink[] = [{ kind, label: `${label} ${recordId.slice(0, 8)}`, recordId, url }]
    if (kind === 'workflowDefinition') {
      const nativeRun = optionalString(row, 'sourceExecutionId')
      if (nativeRun) result.push({ kind: 'workflowRun', label: 'Native run reference', recordId: nativeRun })
    }
    return result
  })
}

export function parseProcessDefinition(value: unknown): ProcessDefinition {
  const row = record(value)
  const rawStages = rows(row, 'stages')
  const stageIds = new Map(rawStages.map(stage => [id(stage, 'stageDefinitionId'), string(stage, 'code')]))
  const laneLabels: Record<string, string> = {
    email: 'Email channel', channel: 'Email channel', workflow: 'Workflow orchestration',
    agents: 'Agents and tools', agent: 'Agents and tools', case: 'Case handling', cases: 'Case handling', employee: 'Case handling',
    'help-flow': 'Workflow orchestration', 'saved-agent': 'Agents and tools',
    'instrumentation-overlay': 'Planned tool observation', 'case-management': 'Case handling',
  }
  const lanes = [...new Set(rawStages.map(stage => string(stage, 'lane')))].map((laneId, order) => ({
    id: laneId, label: laneLabels[laneId] ?? laneId, order,
  }))
  return {
    schemaVersion: 1, definitionId: id(row, 'definitionId'), code: string(row, 'code'),
    name: string(row, 'name'), version: String(integer(row, 'version')),
    coverageVersion: string(row, 'coverageVersion'), mode: 'configuration',
    description: 'Versioned process definition from Dataverse. Only recorded executions establish runtime progress.',
    lanes,
    stages: rawStages.map(stage => ({
      schemaVersion: 1, stageCode: string(stage, 'code'), label: string(stage, 'label'),
      description: stage.completionAuthority === 'case-observer'
        ? 'Conditional case lifecycle observed from committed case transitions.'
        : 'An observed execution boundary; internal steps are not inferred.',
      laneId: string(stage, 'lane'),
      phase: member<BusinessPhase>(string(stage, 'phase'), ['intake', 'identify', 'classify', 'route', 'act', 'review'], 'phase'),
      kind: member(string(stage, 'nodeKind'), ['start', 'task', 'gateway', 'subprocess', 'wait', 'end', 'exception'], 'node kind'),
      order: integer(stage, 'displayOrder'), coverage: coverage(string(stage, 'coverage')),
      optional: !boolean(stage, 'required'), opaque: stage.nodeKind === 'subprocess',
      evidence: stage.completionAuthority === 'case-observer' ? 'lifecycle' : 'inventory',
    })),
    transitions: rows(row, 'transitions').map(edge => {
      const from = stageIds.get(id(edge, 'fromStageId'))
      const to = stageIds.get(id(edge, 'toStageId'))
      if (!from || !to) throw new Error('Process transition refers to a different definition.')
      return {
        schemaVersion: 1, transitionCode: string(edge, 'code'), fromStageCode: from, toStageCode: to,
        label: string(edge, 'label'), branchCode: optionalString(edge, 'branchCode'), optional: !boolean(edge, 'required'),
        kind: edge.eventCode === 'case-reopened' ? 'reopen' : 'sequence',
      }
    }),
    sources: [{ name: 'Dataverse process definition', health: 'available' }],
  }
}

function summary(row: Record<string, unknown>, definition: ProcessDefinition): ProcessSummary {
  if (id(row, 'definitionId') !== definition.definitionId) throw new Error('Process definition does not match the requested version.')
  return {
    schemaVersion: 1, processId: id(row, 'processId'), definitionId: definition.definitionId,
    definitionVersion: definition.version, coverageVersion: definition.coverageVersion,
    state: processState(string(row, 'state')), mode: 'observed',
    receivedAt: requiredDate(row, 'receivedAtUtc'), latestEventAt: date(row, 'lastEventAtUtc'),
    projectionRevision: integer(row, 'revision'), coverage: coverage(string(row, 'coverage')),
    sourceHealth: health(string(row, 'health')),
  }
}

function stageExecution(row: Record<string, unknown>, processId: string, organizationUrl?: string): StageExecution {
  const duration = row.durationMs
  if (duration !== undefined && (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)) throw new Error('Process service returned invalid duration.')
  const attempt = integer(row, 'attempt')
  if (attempt < 1) throw new Error('Process service returned an invalid execution attempt.')
  const startedAt = date(row, 'startedAtUtc')
  const endedAt = date(row, 'endedAtUtc')
  return {
    schemaVersion: 1, stageExecutionId: id(row, 'stageExecutionId'), processId, stageCode: string(row, 'stageCode'),
    attempt, state: member(string(row, 'state'), ['running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled'], 'execution state'),
    parentExecutionId: optionalId(row, 'parentExecutionId'), branch: optionalString(row, 'branch'),
    source: optionalString(row, 'producerId') ?? 'Dataverse case observer',
    sourceVersion: optionalString(row, 'sourceVersion'), startedAt, endedAt,
    durationMs: duration,
    durationProvenance: row.durationProvenance === 'producer-reported' ? 'reported' : row.durationProvenance === undefined ? 'unknown'
      : member(string(row, 'durationProvenance'), ['reported', 'derived', 'unknown'], 'duration provenance'),
    links: links(row, organizationUrl),
  }
}

function processCase(row: Record<string, unknown>, organizationUrl?: string): ProcessCase {
  const state = integer(row, 'state')
  if (state > 2) throw new Error('Process service returned unsupported case state.')
  return {
    caseId: id(row, 'caseId'), role: string(row, 'relationshipRole'),
    blocksCompletion: boolean(row, 'blocksCompletion'),
    state: boolean(row, 'merged') ? 'Merged' : ['Active', 'Resolved', 'Cancelled'][state],
    links: links(row, organizationUrl),
  }
}

export function createProcessReadGateway(transport: ProcessReadTransport, organizationUrl?: string): ProcessReadGateway {
  if (organizationUrl) {
    const url = new URL(organizationUrl)
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.crm.dynamics.com') || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') {
      throw new Error('An approved Dataverse organization URL is required for process record links.')
    }
  }
  const definitions = new Map<string, ProcessDefinition>()
  async function pages(action: ProcessReadAction, key: string, request: Record<string, unknown> = {}) {
    const result: Record<string, unknown>[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    for (let page = 0; page < MAX_PAGES; page++) {
      const value = envelope(await transport(action, { schemaVersion: 1, ...request, ...(cursor ? { cursor } : {}) }))
      result.push(...rows(value, key))
      cursor = optionalString(value, 'nextCursor')
      if (!cursor) return result
      if (seen.has(cursor)) throw new Error('Process service repeated a continuation; results are incomplete.')
      seen.add(cursor)
    }
    throw new Error('Process query exceeded its bounded page limit; narrow the query before displaying counts.')
  }
  async function definitionFor(definitionId: string): Promise<ProcessDefinition> {
    const existing = definitions.get(definitionId)
    if (existing) return existing
    const loaded = await pages('rfd_GetProcessDefinitions', 'definitions', { definitionId, pageSize: 10 })
    const definition = loaded.map(parseProcessDefinition).find(item => item.definitionId === definitionId)
    if (!definition) throw new Error('The recorded process definition is unavailable to this user.')
    definitions.set(definitionId, definition)
    return definition
  }
  return {
    async loadProcessDefinitions() {
      const loaded = (await pages('rfd_GetProcessDefinitions', 'definitions', { pageSize: 10 })).map(parseProcessDefinition)
      loaded.forEach(item => definitions.set(item.definitionId, item))
      return loaded
    },
    async listProcesses() {
      const loaded = await pages('rfd_ListEmailProcesses', 'processes', { pageSize: 100 })
      const result: ProcessSummary[] = []
      const seen = new Set<string>()
      for (const row of loaded) {
        const processId = id(row, 'processId')
        if (seen.has(processId)) throw new Error('Process listing changed during paging; refresh before displaying counts.')
        seen.add(processId)
        result.push(summary(row, await definitionFor(id(row, 'definitionId'))))
      }
      return result
    },
    async getProcessState(processId): Promise<ProcessSnapshot> {
      if (!GUID.test(processId)) throw new Error('A full process GUID is required.')
      const value = envelope(await transport('rfd_GetEmailProcessState', { schemaVersion: 1, processId }))
      const process = record(value.process)
      if (id(process, 'processId') !== processId.toLowerCase() || integer(value, 'revision') !== integer(process, 'revision')) throw new Error('Process response identity or revision changed.')
      const definition = await definitionFor(id(process, 'definitionId'))
      const overview = summary(process, definition)
      const reconciliation = boolean(process, 'reconciliationRequired')
      return {
        ...overview, definition, fetchedAt: new Date().toISOString(),
        stages: rows(value, 'stageExecutions').map(row => stageExecution(row, overview.processId, organizationUrl)),
        cases: rows(value, 'caseLinks').map(row => processCase(row, organizationUrl)), links: links(process, organizationUrl),
        sources: [{ name: 'Dataverse process ledger', health: overview.sourceHealth, observedAt: overview.latestEventAt,
          message: reconciliation ? 'Reconciliation is required; the recorded history is incomplete.' : `Business state: ${string(process, 'state')}.` }],
      }
    },
    async getProcessEvents(processId, cursor): Promise<ProcessEventPage> {
      if (!GUID.test(processId)) throw new Error('A full process GUID is required.')
      const value = envelope(await transport('rfd_GetEmailProcessEvents', { schemaVersion: 1, processId, pageSize: 100, ...(cursor ? { cursor } : {}) }))
      if (id(value, 'processId') !== processId.toLowerCase()) throw new Error('Event history belongs to a different process.')
      const upper = integer(value, 'upperRevision')
      const events: ProcessEvent[] = rows(value, 'events').map(row => {
        if (id(row, 'processId') !== processId.toLowerCase() || integer(row, 'revision') > upper) throw new Error('Event history violates its process/revision boundary.')
        return {
          schemaVersion: 1, eventId: id(row, 'eventId'), processId: id(row, 'processId'),
          stageExecutionId: optionalId(row, 'stageExecutionId'), stageCode: optionalString(row, 'stageCode'),
          eventType: string(row, 'eventType'), outcome: optionalString(row, 'outcome'),
          source: string(row, 'producerId'), sourceVersion: optionalString(row, 'sourceVersion'),
          occurredAt: requiredDate(row, 'occurredAtUtc'), recordedAt: requiredDate(row, 'recordedAtUtc'),
          projectionRevision: integer(row, 'revision'), links: links(row, organizationUrl),
        }
      })
      return { schemaVersion: 1, processId: processId.toLowerCase(), events, nextCursor: optionalString(value, 'nextCursor') }
    },
  }
}
