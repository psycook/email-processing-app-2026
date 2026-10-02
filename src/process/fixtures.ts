import { WALKTHROUGH_PROCESS as INVENTORIED_PROCESS } from './definition.ts'
import type { ProcessFixture, ProcessState, StageExecution } from './types'

const BASE_TIME = Date.parse('2026-10-02T09:00:00Z')
const at = (seconds: number) => new Date(BASE_TIME + seconds * 1000).toISOString()

function fixture(id: string, label: string, description: string, index: number): ProcessFixture {
  const processId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  return {
    id, label, description,
    definition: { ...INVENTORIED_PROCESS, mode: 'synthetic', coverageVersion: 'synthetic-v1' },
    snapshot: {
      schemaVersion: 1, processId, definitionId: INVENTORIED_PROCESS.definitionId, definitionVersion: '1',
      coverageVersion: 'synthetic-v1', state: 'succeeded', mode: 'synthetic', receivedAt: at(0),
      latestEventAt: at(28), projectionRevision: 1, coverage: 'partial', sourceHealth: 'available',
      fetchedAt: at(90), stages: [], cases: [], links: [],
      sources: [{ name: 'Local synthetic fixture', health: 'available', observedAt: at(90), message: 'Illustrative data only. No mailbox, workflow or Dataverse call.' }],
    },
    eventPage: { schemaVersion: 1, processId, events: [] },
  }
}

function span(item: ProcessFixture, code: string, state: ProcessState, start: number, end?: number, attempt = 1, branch?: string): void {
  const sequence = item.snapshot.stages.length + 1
  const suffix = (BigInt(item.snapshot.processId.slice(-12)) * 100n + BigInt(sequence)).toString().padStart(12, '0')
  const execution: StageExecution = {
    schemaVersion: 1, stageExecutionId: `00000000-0000-4000-8001-${suffix}`,
    processId: item.snapshot.processId, stageCode: code, state, attempt, branch,
    source: 'Synthetic workflow producer', sourceVersion: String(sequence), occurredAt: at(end ?? start),
    recordedAt: at((end ?? start) + 2), startedAt: at(start), endedAt: end === undefined ? undefined : at(end),
    durationMs: end === undefined || state === 'waiting' ? undefined : (end - start) * 1000,
    durationProvenance: end === undefined || state === 'waiting' ? 'unknown' : 'reported', links: [],
  }
  item.snapshot.stages.push(execution)
  item.eventPage.events.push({
    schemaVersion: 1, eventId: `00000000-0000-4000-8002-${suffix}`, processId: item.snapshot.processId,
    stageExecutionId: execution.stageExecutionId, stageCode: code, eventType: `stage.${state}`,
    outcome: state, source: execution.source, occurredAt: execution.occurredAt, recordedAt: at((end ?? start) + 2),
    projectionRevision: sequence, links: [],
  })
  item.snapshot.projectionRevision = sequence
  item.snapshot.latestEventAt = execution.occurredAt
}

function intake(item: ProcessFixture): void {
  span(item, 'intake', 'succeeded', 0, 1)
  span(item, 'classify', 'succeeded', 1, 4)
  span(item, 'route', 'succeeded', 4, 5)
}

function blockingCase(item: ProcessFixture, state: string): void {
  item.snapshot.cases = [{
    caseId: '00000000-0000-4000-8000-100000000001', role: 'blocking', blocksCompletion: true,
    linkedAt: at(20), state, links: [{ kind: 'case', label: 'Synthetic linked case · no live record', recordId: '00000000-0000-4000-8000-100000000001' }],
  }]
}

const straight = fixture('straight-through', 'Straight-through', 'One observed outer agent invocation completes; internal identity and tool timings remain unknown.', 1)
intake(straight)
span(straight, 'card-service', 'succeeded', 5, 25)
span(straight, 'default-response', 'skipped', 5, 5)
span(straight, 'completed', 'succeeded', 25, 25)

const handoff = fixture('human-handoff', 'Human handoff', 'The agent has finished; an explicitly linked blocking case is still waiting for a person.', 2)
intake(handoff)
span(handoff, 'card-service', 'succeeded', 5, 20)
span(handoff, 'human-review', 'waiting', 20)
handoff.snapshot.state = 'waiting'
blockingCase(handoff, 'active')

const parallel = fixture('parallel-branches', 'Parallel branches', 'Two synthetic outer invocations demonstrate independent branch state. This is not a claim that the inventoried exclusive classifier forks.', 3)
intake(parallel)
span(parallel, 'card-service', 'succeeded', 5, 20, 1, 'holding-a')
span(parallel, 'card-service', 'running', 6, undefined, 1, 'holding-b')
parallel.snapshot.state = 'running'

const failure = fixture('failure', 'Failure', 'An explicitly reported failure is shown separately from missing telemetry.', 4)
intake(failure)
span(failure, 'card-service', 'failed', 5, 12)
failure.snapshot.stages.at(-1)!.errorCode = 'SYNTHETIC_DEPENDENCY_FAILURE'
span(failure, 'exception', 'failed', 12, 12)
failure.snapshot.state = 'failed'

const retry = fixture('retry', 'Retry', 'The failed first attempt remains in the audit trail; the second attempt is separately measured.', 5)
intake(retry)
span(retry, 'card-service', 'failed', 5, 12)
span(retry, 'card-service', 'succeeded', 15, 28, 2)
span(retry, 'completed', 'succeeded', 28, 28)

const skipped = fixture('skipped-stage', 'Default / skipped', 'An explicitly skipped servicing branch is not treated as missing data or a successful invocation.', 6)
intake(skipped)
span(skipped, 'card-service', 'skipped', 5, 5)
span(skipped, 'default-response', 'succeeded', 5, 8)
span(skipped, 'completed', 'succeeded', 8, 8)

const reopened = fixture('reopened-case', 'Reopened case', 'Historical completion is retained. A reopened blocking case returns the process to a new review wait.', 7)
intake(reopened)
span(reopened, 'card-service', 'succeeded', 5, 20)
span(reopened, 'human-review', 'succeeded', 20, 40)
span(reopened, 'completed', 'succeeded', 40, 40)
span(reopened, 'human-review', 'waiting', 60, undefined, 2)
reopened.eventPage.events.at(-1)!.eventType = 'case.reopened'
reopened.eventPage.events.at(-1)!.transitionCode = 'completed-reopened'
reopened.snapshot.state = 'waiting'
blockingCase(reopened, 'reopened')

const unavailable = fixture('unavailable-source', 'Unavailable source', 'The last-known snapshot is retained and marked stale. A failed read does not change execution states.', 8)
intake(unavailable)
span(unavailable, 'card-service', 'running', 5)
unavailable.snapshot.state = 'running'
unavailable.snapshot.sourceHealth = 'unavailable'
unavailable.snapshot.sources = [{ name: 'Synthetic ledger source', health: 'unavailable', observedAt: at(10), message: 'Illustrative unavailable source. Display is last known, not current.' }]

const unknown = fixture('unknown-coverage', 'Unknown coverage', 'Only intake is known. No execution rows are fabricated for absent operations.', 9)
span(unknown, 'intake', 'succeeded', 0, 1)
unknown.snapshot.state = 'unknown'
unknown.snapshot.coverage = 'unknown'

export const PROCESS_FIXTURES: ProcessFixture[] = [straight, handoff, parallel, failure, retry, skipped, reopened, unavailable, unknown]
