import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../ui/studioContext'
import { Card, CardHeader, SectionLabel, Badge, MetaRow, EmptyState } from '../ui/primitives'
import { InlineNote } from '../ui/Banners'
import { Pipeline } from '../ui/Pipeline'
import { PIPELINE_STAGES } from '../ui/constants'
import { messagesForMailbox, openCases, unreadMessages, notesForCase, sourceHealthy } from '../ui/selectors'
import { relativeTime } from '../ui/util'
import { formatDate } from '../lib/studioEngine'
import { Workflow, Database, FileText, ClipboardCheck, CircleDot, Zap } from '../ui/icons'
import { RefreshCw, ShieldCheck } from 'lucide-react'
import { ProcessCanvas, ProcessEventTimeline, ProcessRecordLinks } from '../ui/ProcessCanvas'
import { INVENTORIED_PROCESS, legacyProcessEnabled, PROCESS_STATE_LABELS, processTime } from '../process/definition'
import { PROCESS_FIXTURES } from '../process/fixtures'
import { mergeEventPage } from '../process/eventPages'
import type { ProcessDefinition, ProcessEvent, ProcessReadGateway, ProcessSnapshot, ProcessSummary } from '../process/types'

interface ReadState {
  definitions: ProcessDefinition[]
  processes: ProcessSummary[]
  snapshot?: ProcessSnapshot
  events: ProcessEvent[]
  nextCursor?: string
  refreshedAt?: string
  error?: string
  loading: boolean
}

function useProcessRead(gateway: ProcessReadGateway | undefined, processId: string, enabled: boolean, polling: boolean, pollSeconds: number) {
  const [read, setRead] = useState<ReadState>({ definitions: [], processes: [], events: [], loading: false })
  const pending = useRef<Promise<void> | undefined>(undefined)
  const commands = useRef<{ refresh: () => void; more: (cursor: string) => void }>({ refresh: () => {}, more: () => {} })
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const visible = () => document.visibilityState !== 'hidden'
    const schedule = () => {
      clearTimeout(timer)
      if (!disposed && enabled && polling && gateway && visible()) timer = setTimeout(() => { void load() }, pollSeconds * 1000)
    }
    async function load(cursor?: string) {
      if (!gateway || !enabled || !visible() || disposed) return
      clearTimeout(timer)
      // Selections, visibility changes and manual refresh all share one in-flight read.
      const previousOperation = pending.current
      if (previousOperation) await previousOperation
      if (disposed || !visible()) return
      if (pending.current && pending.current !== previousOperation) { schedule(); return }
      setRead(previous => ({ ...previous, loading: true }))
      const operation = (async () => {
        try {
          if (cursor && processId) {
            const page = await gateway.getProcessEvents(processId, cursor)
            if (!disposed && page.processId === processId) setRead(previous => ({
              ...previous, ...mergeEventPage(previous.events, page, previous.snapshot?.projectionRevision ?? 0),
              error: undefined,
            }))
          } else {
            const results = await Promise.allSettled([
              gateway.loadProcessDefinitions(), gateway.listProcesses(),
              processId ? gateway.getProcessState(processId) : Promise.resolve(undefined),
              processId ? gateway.getProcessEvents(processId) : Promise.resolve(undefined),
            ])
            const [definitionResult, processResult, snapshotResult, pageResult] = results
            if (definitionResult.status === 'rejected' || processResult.status === 'rejected' ||
              snapshotResult.status === 'rejected' || pageResult.status === 'rejected') {
              const failed = results.find(result => result.status === 'rejected')
              throw new Error(failed?.status === 'rejected' && failed.reason instanceof Error
                ? failed.reason.message : 'Process service failed without an error detail.')
            }
            const definitions = definitionResult.value
            const processes = processResult.value
            const snapshot = snapshotResult.value
            const page = pageResult.value
            if ((snapshot && snapshot.processId !== processId) || (page && page.processId !== processId)) throw new Error('The ledger returned a different process. No data has been associated.')
            if (!disposed) setRead(previous => {
              const sameProcess = previous.snapshot?.processId === snapshot?.processId
              if (sameProcess && snapshot && previous.snapshot && snapshot.projectionRevision < previous.snapshot.projectionRevision) {
                return { ...previous, error: 'An older process revision was ignored. Refresh to retrieve current state.' }
              }
              return {
                definitions, processes, snapshot,
                ...(page && snapshot ? mergeEventPage(sameProcess ? previous.events : [], page, snapshot.projectionRevision)
                  : { events: [], nextCursor: undefined }),
                refreshedAt: new Date().toISOString(), loading: true,
              }
            })
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'The process source failed without an error detail.'
          if (!disposed) setRead(previous => ({ ...previous, error: `${reason} Any retained values are last known, not current. Refresh to retry.` }))
        } finally {
          if (!disposed) setRead(previous => ({ ...previous, loading: false }))
        }
      })()
      pending.current = operation
      await operation
      if (pending.current === operation) pending.current = undefined
      schedule()
    }
    const onVisibility = () => {
      clearTimeout(timer)
      if (visible()) void load()
    }
    commands.current = {
      refresh: () => { if (!pending.current) void load() },
      more: cursor => { if (!pending.current) void load(cursor) },
    }
    document.addEventListener('visibilitychange', onVisibility)
    void load()
    return () => {
      disposed = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [gateway, processId, enabled, polling, pollSeconds])
  return { ...read, refresh: () => commands.current.refresh(), loadMore: () => { if (read.nextCursor) commands.current.more(read.nextCursor) } }
}

export function ProcessPage({ gateway }: { gateway?: ProcessReadGateway }) {
  return legacyProcessEnabled() ? <LegacyProcessPage /> : <ProcessStudio gateway={gateway} />
}

function ProcessStudio({ gateway }: { gateway?: ProcessReadGateway }) {
  const { studio } = useApp()
  const [view, setView] = useState<'definition' | 'instance' | 'synthetic'>('definition')
  const [processId, setProcessId] = useState('')
  const [definitionId, setDefinitionId] = useState('')
  const [fixtureId, setFixtureId] = useState(PROCESS_FIXTURES[0].id)
  const read = useProcessRead(gateway, view === 'instance' ? processId : '', view !== 'synthetic',
    studio.state.settings.polling, studio.state.settings.pollSeconds)
  const fixture = PROCESS_FIXTURES.find(item => item.id === fixtureId) ?? PROCESS_FIXTURES[0]
  const selectedSnapshot = read.snapshot?.processId === processId ? read.snapshot : undefined
  const snapshot = view === 'synthetic' ? fixture.snapshot : view === 'instance' ? selectedSnapshot : undefined
  const events = view === 'synthetic' ? fixture.eventPage.events : view === 'instance' && selectedSnapshot ? read.events : []
  const definitions = gateway ? read.definitions : [INVENTORIED_PROCESS]
  const definition = view === 'synthetic' ? fixture.definition
    : snapshot ? snapshot.definition ?? definitions.find(item => item.definitionId === snapshot.definitionId && item.version === snapshot.definitionVersion)
      : view === 'instance' ? undefined
        : definitions.find(item => item.definitionId === definitionId) ?? definitions[0]
  const coverageGroups = new Set(read.processes.map(item => `${item.definitionId}|${item.definitionVersion}|${item.coverageVersion}`))
  const sourceUnavailable = (view !== 'synthetic' && Boolean(read.error)) || snapshot?.sourceHealth === 'unavailable' || snapshot?.sourceHealth === 'stale'

  return (
    <div className="page process-studio">
      <section className="page-head">
        <div>
          <SectionLabel>Process studio · read-only</SectionLabel>
          <h1 className="page-title">A simple view of the email process.</h1>
          <p className="page-lede">Start with the business flow from shared mailbox to email response. Use the stage list and ledger details only when you need the underlying evidence.</p>
        </div>
        <span className="process-readonly"><ShieldCheck size={16} /> No workflow changes</span>
      </section>
      <section className="process-workspace">
        <div className="process-studio__toolbar">
          <div className="process-view-switch" aria-label="Process view">
            <button type="button" aria-pressed={view === 'definition'} onClick={() => setView('definition')}>Definition</button>
            <button type="button" aria-pressed={view === 'instance'} onClick={() => setView('instance')}>Received messages</button>
            <button type="button" aria-pressed={view === 'synthetic'} onClick={() => setView('synthetic')}>Synthetic walkthroughs</button>
          </div>
          <button type="button" className="process-refresh" disabled={!gateway || view === 'synthetic' || read.loading} onClick={read.refresh}><RefreshCw size={14} />{read.loading ? 'Refreshing…' : 'Refresh ledger'}</button>
        </div>
        {view === 'synthetic' ? (
          <div className="process-notice process-notice--synthetic">
            <strong>Synthetic fixture · not live telemetry</strong>
            <p>Local, fixed examples for reviewing the experience. These do not represent customer email, actual flow runs or case records.</p>
            <label className="process-field">Walkthrough
              <select value={fixtureId} onChange={event => setFixtureId(event.target.value)}>{PROCESS_FIXTURES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
            </label>
            <p>{fixture.description}</p>
          </div>
        ) : !gateway ? (
          <div className="process-notice"><strong>Configuration only · runtime source not connected</strong><p>The inventoried graph is not proof of execution. Use the labelled synthetic walkthroughs to explore instance details. No process API requests are made.</p></div>
        ) : (
          <div className={`process-notice${read.error ? ' process-notice--warning' : ''}`} role="status">
            <strong>{read.error ? 'Source unavailable · last known data' : 'Read-only ledger'}</strong>
            <p>{read.error ?? `${studio.state.settings.polling ? `Refreshes every ${studio.state.settings.pollSeconds} seconds while visible, with no overlapping polls.` : 'Automatic refresh is paused. Use Refresh ledger for current data.'} Last successful read: ${processTime(read.refreshedAt)}.`}</p>
          </div>
        )}
        {view === 'definition' && definitions.length > 1 ? <label className="process-field process-picker">Definition<select value={definition?.definitionId ?? ''} onChange={event => setDefinitionId(event.target.value)}>{definitions.map(item => <option key={item.definitionId} value={item.definitionId}>{item.name} · v{item.version}</option>)}</select></label> : null}
        {view === 'instance' ? (
          <div className="process-instance-picker">
            <label className="process-field">Received-message process
              <select value={processId} onChange={event => setProcessId(event.target.value)} disabled={!gateway}>
                <option value="">Select a canonical ProcessId</option>
                {read.processes.map(item => <option key={item.processId} value={item.processId}>{processTime(item.receivedAt)} · {PROCESS_STATE_LABELS[item.state]} · {item.processId}</option>)}
              </select>
            </label>
            <p className="process-muted">{read.processes.length} returned process records · {coverageGroups.size} definition / coverage cohort{coverageGroups.size === 1 ? '' : 's'}. This is not an Inbox-to-case conversion funnel. Open-case backlog is separate.</p>
            {gateway && !read.loading && !read.processes.length ? <p className="process-empty">No tracked received messages returned. Existing Inbox messages are not automatically instrumented.</p> : null}
          </div>
        ) : null}
        {snapshot ? (
          <div className="process-instance-summary">
            <div><span className="process-eyebrow">Canonical ProcessId</span><strong className="process-mono">{snapshot.processId}</strong></div>
            <div><span className="process-eyebrow">Process outcome{sourceUnavailable ? ' · last known' : ''}</span><strong className={`process-status process-status--${snapshot.state}`}>{PROCESS_STATE_LABELS[snapshot.state]}</strong></div>
            <div><span className="process-eyebrow">Received</span><strong>{processTime(snapshot.receivedAt)}</strong></div>
            <div><span className="process-eyebrow">Coverage / revision</span><strong>{snapshot.coverageVersion} · r{snapshot.projectionRevision}</strong></div>
          </div>
        ) : null}
        {definition ? (
          <>
            <div className="process-definition-head"><div><span className="process-eyebrow">{definition.code} · version {definition.version}</span><h2>{definition.name}</h2></div><span className="process-coverage">{snapshot?.coverage ?? 'Configuration inventory'}</span></div>
            <p className="process-definition-description">{definition.description}</p>
            <ProcessCanvas definition={definition} snapshot={sourceUnavailable && snapshot ? { ...snapshot, sourceHealth: 'stale' } : snapshot} events={events} />
          </>
        ) : <p className="process-empty">{snapshot ? 'The exact definition/version for this process is unavailable. No fallback graph is substituted.' : view === 'instance' ? 'Choose a received message to inspect its actual execution history.' : read.loading ? 'Loading versioned definitions…' : 'No process definition is available from this source.'}</p>}
      </section>
      {snapshot ? (
        <div className="process-audit-grid">
          <Card>
            <CardHeader label="Immutable ledger" title="Events & provenance" description="Occurred time is the producer’s fact; recorded time is the ledger receipt. Events are ordered by projection revision." />
            <ProcessEventTimeline events={events} />
            {view === 'instance' && read.nextCursor ? <button type="button" className="process-refresh" disabled={read.loading} onClick={read.loadMore}>Load more events</button> : null}
          </Card>
          <div className="process-audit-side">
            <Card><CardHeader label="Coverage & freshness" title="What this snapshot can tell you" />
              <dl className="process-facts">
                <div><dt>Snapshot read</dt><dd>{processTime(snapshot.fetchedAt)}</dd></div>
                <div><dt>Latest occurred</dt><dd>{processTime(snapshot.latestEventAt)}</dd></div>
                <div><dt>Source health</dt><dd>{sourceUnavailable ? 'Unavailable / stale · last known' : snapshot.sourceHealth}</dd></div>
                <div><dt>Coverage</dt><dd>{snapshot.coverage}</dd></div>
              </dl>
              <ul className="process-sources">{snapshot.sources.map((source, index) => <li key={`${source.name}-${index}`}><strong>{source.name} · {source.health}</strong><span>Observed: {processTime(source.observedAt)}</span>{source.message ? <p>{source.message}</p> : null}</li>)}</ul>
            </Card>
            <Card><CardHeader label="Native records" title="Explicitly linked evidence" /><ProcessRecordLinks links={snapshot.links} />
              <h3 className="process-subheading">Linked cases · {snapshot.cases.length}</h3>
              {snapshot.cases.length ? <ul className="process-cases">{snapshot.cases.map(item => <li key={item.caseId}><strong>{item.state} · {item.blocksCompletion ? 'Blocks completion' : 'Non-blocking'}</strong><p>{item.role} · linked {processTime(item.linkedAt)}</p><ProcessRecordLinks links={item.links.length ? item.links : [{ kind: 'case', label: item.caseId, recordId: item.caseId }]} /></li>)}</ul> : <p className="process-muted">No explicit case relationship reported. No association is inferred from subject, sender or the current backlog.</p>}
            </Card>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function LegacyProcessPage() {
  const { studio } = useApp()
  const { state } = studio
  const { snapshot } = state
  const [selectedId, setSelectedId] = useState<string>('mailbox')

  const stage = useMemo(() => PIPELINE_STAGES.find((item) => item.id === selectedId) ?? PIPELINE_STAGES[0], [selectedId])
  const open = useMemo(() => openCases(snapshot), [snapshot])
  const intake = useMemo(() => messagesForMailbox(snapshot, state.settings.helpMailbox), [snapshot, state.settings.helpMailbox])
  const unread = useMemo(() => unreadMessages(intake), [intake])
  const mailReady = sourceHealthy(snapshot, `Inbox: ${state.settings.helpMailbox}`)
  const casesReady = sourceHealthy(snapshot, 'Cases')

  const recentNotes = useMemo(() => [...snapshot.notes].slice(0, 6), [snapshot.notes])
  const recentTasks = useMemo(() => [...snapshot.tasks].slice(0, 6), [snapshot.tasks])

  const counts = {
    mailbox: { value: mailReady ? intake.length : '—', label: 'help inbox window' },
    review: { value: casesReady ? open.length : '—', label: 'open cases' },
  }

  const liveMetric = (): { value: string; note: string } => {
    if (stage.id === 'mailbox') return { value: mailReady ? `${unread.length} unread / ${intake.length}` : 'Unavailable', note: 'Help Inbox only; excludes customer mailbox replies. See source health for errors or stale data.' }
    if (stage.id === 'review') return { value: casesReady ? `${open.length} open` : 'Unavailable', note: 'Observed from Dataverse incidents; see source health for errors or stale data.' }
    return { value: 'Not exposed', note: 'This connector does not report per-stage runtime counts.' }
  }

  const metric = liveMetric()
  const workflow = snapshot.workflow

  return (
    <div className="page">
      <section className="page-head">
        <div>
          <SectionLabel>Process studio</SectionLabel>
          <h1 className="page-title">How a message becomes an outcome</h1>
          <p className="page-lede">
            Six configured stages take an inbound email from the shared mailbox through to a resolved case. Select any
            stage to inspect its data source, configuration and the connector action behind it.
          </p>
        </div>
      </section>

      <Card>
        <CardHeader label="Automation definition" title={workflow?.name ?? 'Email handling workflow'} />
        {workflow ? (
          <>
            <div className="workflow-meta">
              <Badge tone={workflow.active ? 'success' : 'neutral'}>
                <CircleDot size={13} /> Config {workflow.active ? 'ACTIVE' : 'inactive'}
              </Badge>
              <span className="muted-note">Help mailbox: {workflow.helpMailbox}</span>
            </div>
            {workflow.description ? <p className="workflow-desc">{workflow.description}</p> : null}
            {workflow.categories.length > 0 ? (
              <div className="chip-row">
                {workflow.categories.map((category) => (
                  <span className="chip" key={category}>
                    {category}
                  </span>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState icon={<Workflow size={20} />} title="Workflow metadata unavailable" description="The workflow connector did not return a definition in this snapshot." />
        )}
        <InlineNote tone="warning">
          <strong>Config state is not run state.</strong> “ACTIVE” means the automation is published and enabled — it does
          not mean a run is executing right now. Live run telemetry is not exposed by these connectors, so no
          in-flight counts are shown.
        </InlineNote>
      </Card>

      <Card className="pipeline-card">
        <CardHeader label="Pipeline" title="Select a stage to inspect" />
        <Pipeline counts={counts} activeId={selectedId} onSelect={setSelectedId} refreshing={state.refreshing} />
      </Card>

      <div className="split-2">
        <Card>
          <CardHeader
            label={`Stage ${PIPELINE_STAGES.findIndex((s) => s.id === stage.id) + 1} of 6`}
            title={stage.label}
            actions={
              <Badge tone={stage.instrumented ? 'success' : 'lavender'} soft>
                {stage.instrumented ? 'Instrumented' : 'Config only'}
              </Badge>
            }
          />
          <p className="stage-summary">{stage.summary}</p>
          <MetaRow
            items={[
              { label: (<><Database size={13} /> Data source</>), value: stage.dataSource },
              { label: (<><Workflow size={13} /> Configuration</>), value: stage.config },
              { label: (<><Zap size={13} /> Connector action</>), value: <code className="inline-code">{stage.action}</code> },
            ]}
          />
          <div className="stage-live">
            <SectionLabel>Live reading</SectionLabel>
            <p className="stage-live__value">{metric.value}</p>
            <p className="muted-note">{metric.note}</p>
          </div>
        </Card>

        <Card>
          <CardHeader label="Audit trail" title="Notes & tasks on cases" description="Artefacts the automation and agents have written to linked cases." />
          <div className="audit">
            <div className="audit__col">
              <SectionLabel>
                <FileText size={12} /> Recent notes
              </SectionLabel>
              {recentNotes.length === 0 ? (
                <p className="muted-note">No notes recorded.</p>
              ) : (
                <ul className="audit-list">
                  {recentNotes.map((note) => (
                    <li key={note.id}>
                      <span className="audit-list__title">{note.subject || note.filename || 'Note'}</span>
                      <span className="audit-list__meta">
                        {notesForCase(snapshot, note.caseId).length ? `Case linked · ` : ''}
                        {relativeTime(note.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="audit__col">
              <SectionLabel>
                <ClipboardCheck size={12} /> Recent tasks
              </SectionLabel>
              {recentTasks.length === 0 ? (
                <p className="muted-note">No tasks recorded.</p>
              ) : (
                <ul className="audit-list">
                  {recentTasks.map((task) => (
                    <li key={task.id}>
                      <span className="audit-list__title">{task.subject || 'Task'}</span>
                      <span className="audit-list__meta">
                        {task.status}
                        {task.dueAt ? ` · due ${formatDate(task.dueAt)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
