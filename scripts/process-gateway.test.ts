import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createProcessReadGateway } from '../src/services/processGateway.ts'
import type { ProcessReadAction } from '../src/services/processGateway.ts'
import { latestBranchAttempts } from '../src/process/definition.ts'
import type { StageExecution } from '../src/process/types.ts'
import { mergeEventPage } from '../src/process/eventPages.ts'
import type { ProcessEvent, ProcessEventPage } from '../src/process/types.ts'

const contract = JSON.parse(readFileSync(new URL('../server/process-contract.json', import.meta.url), 'utf8'))
const examples: Record<ProcessReadAction, unknown> = contract.responseExamples
const processId = '11111111-1111-4111-8111-111111111111'
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

test('read gateway maps actual server response examples to the UI contract', async () => {
  const gateway = createProcessReadGateway(async action => clone(examples[action]), 'https://example.crm.dynamics.com')
  const definitions = await gateway.loadProcessDefinitions()
  assert.equal(definitions[0].version, '1')
  assert.equal(definitions[0].stages[0].coverage, 'instrumented')
  const listed = await gateway.listProcesses()
  assert.equal(listed[0].processId, processId)
  assert.equal(listed[0].state, 'running')
  const state = await gateway.getProcessState(processId)
  assert.equal(state.state, 'waiting')
  assert.equal(state.definition?.definitionId, state.definitionId)
  assert.equal(state.sourceHealth, 'available')
  assert.equal(state.cases[0].state, 'Active')
  assert.match(state.cases[0].links[0].url ?? '', /^https:\/\/example\.crm\.dynamics\.com\/main\.aspx\?/)
  assert.equal(state.stages[0].durationMs, undefined)
  assert.equal(state.stages[0].recordedAt, undefined)
  const events = await gateway.getProcessEvents(processId)
  assert.equal(events.events[0].eventType, 'received')
  assert.equal(events.events[0].projectionRevision, 1)
})

test('unsupported service schema is not converted into synthetic success', async () => {
  const gateway = createProcessReadGateway(async () => ({ schemaVersion: 2, definitions: [] }))
  await assert.rejects(gateway.loadProcessDefinitions(), /Unsupported/)
})

test('mismatched process identity and inconsistent revision are rejected', async () => {
  for (const mutate of [
    (value: Record<string, unknown>) => { value.revision = 999 },
    (value: Record<string, unknown>) => { value.process = { ...value.process as object, processId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } },
  ]) {
    const gateway = createProcessReadGateway(async action => {
      const value = clone(examples[action]) as Record<string, unknown>
      if (action === 'rfd_GetEmailProcessState') mutate(value)
      return value
    })
    await assert.rejects(gateway.getProcessState(processId), /identity or revision/)
  }
})

test('gateway follows list paging but rejects repeated continuation', async () => {
  const gateway = createProcessReadGateway(async action => ({
    ...(clone(examples[action]) as object), nextCursor: 'same-cursor',
  }))
  await assert.rejects(gateway.listProcesses(), /repeated a continuation/)
})

test('event data cannot cross the process or upper-revision boundary', async () => {
  const gateway = createProcessReadGateway(async action => {
    const value = clone(examples[action]) as { schemaVersion: number; upperRevision: number }
    if (action === 'rfd_GetEmailProcessEvents') value.upperRevision = 0
    return value
  })
  await assert.rejects(gateway.getProcessEvents(processId), /boundary/)
})

test('record-link destinations cannot be arbitrary external endpoints', () => {
  assert.throws(() => createProcessReadGateway(async () => undefined, 'https://example.com'), /organization URL/)
  assert.throws(() => createProcessReadGateway(async () => undefined, 'http://example.crm.dynamics.com'), /organization URL/)
})

test('separate blocking cases keep separate review attempts even when branch names match', () => {
  const review: StageExecution = {
    schemaVersion: 1, stageExecutionId: 'first', processId, stageCode: 'reviewcase',
    attempt: 1, state: 'waiting', source: 'case-observer', durationProvenance: 'unknown',
    links: [{ kind: 'case', label: 'First case', recordId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
  }
  const another: StageExecution = { ...review, stageExecutionId: 'second', links: [
    { kind: 'case', label: 'Second case', recordId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  ] }
  const reopened: StageExecution = { ...review, stageExecutionId: 'reopened', attempt: 2 }
  const latest = latestBranchAttempts([review, another, reopened])
  assert.equal(latest.length, 2)
  assert.deepEqual(new Set(latest.map(item => item.stageExecutionId)), new Set(['second', 'reopened']))
})

test('native producer-reported durations retain their provenance in the UI', async () => {
  const gateway = createProcessReadGateway(async action => {
    const value = clone(examples[action])
    if (action === 'rfd_GetEmailProcessState') {
      const result = value as { stageExecutions: Record<string, unknown>[] }
      result.stageExecutions[0].durationMs = 1234
      result.stageExecutions[0].durationProvenance = 'producer-reported'
    }
    return value
  })
  const snapshot = await gateway.getProcessState(processId)
  assert.equal(snapshot.stages[0].durationMs, 1234)
  assert.equal(snapshot.stages[0].durationProvenance, 'reported')
})

test('partial reconciliation health remains visible in lists and details', async () => {
  const gateway = createProcessReadGateway(async action => {
    const value = clone(examples[action]) as Record<string, unknown>
    const processes = action === 'rfd_GetEmailProcessState'
      ? [value.process] : action === 'rfd_ListEmailProcesses' ? value.processes : []
    for (const process of processes as Record<string, unknown>[]) {
      process.health = 'partial'
      process.state = 'needs-reconciliation'
      process.reconciliationRequired = true
    }
    return value
  })
  const list = await gateway.listProcesses()
  assert.equal(list[0].sourceHealth, 'stale')
  assert.equal(list[0].state, 'unknown')
  const detail = await gateway.getProcessState(processId)
  assert.equal(detail.sourceHealth, 'stale')
  assert.match(detail.sources[0].message ?? '', /Reconciliation is required/)
})

test('refresh restarts exhausted event paging and makes appended events reachable', () => {
  const event = (revision: number): ProcessEvent => ({
    schemaVersion: 1, eventId: String(revision), processId, eventType: 'completed',
    source: 'fixture', recordedAt: '2026-10-02T12:00:00Z', projectionRevision: revision, links: [],
  })
  const previous = Array.from({ length: 150 }, (_, index) => event(index + 1))
  const fresh: ProcessEventPage = {
    schemaVersion: 1, processId, events: previous.slice(0, 100), nextCursor: 'new-session-page-2',
  }
  const refreshed = mergeEventPage(previous, fresh, 151)
  assert.equal(refreshed.nextCursor, 'new-session-page-2')
  const next = mergeEventPage(refreshed.events, {
    schemaVersion: 1, processId, events: [...previous.slice(100), event(151)],
  }, 151)
  assert.equal(next.events.length, 151)
  assert.equal(next.events.at(-1)?.projectionRevision, 151)
  assert.equal(next.nextCursor, undefined)
})
