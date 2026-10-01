import { useMemo, useState } from 'react'
import { useApp } from '../ui/studioContext'
import { Card, CardHeader, SectionLabel, Badge, MetaRow, EmptyState } from '../ui/primitives'
import { InlineNote } from '../ui/Banners'
import { Pipeline } from '../ui/Pipeline'
import { PIPELINE_STAGES } from '../ui/constants'
import { messagesForMailbox, openCases, unreadMessages, notesForCase, sourceHealthy } from '../ui/selectors'
import { relativeTime } from '../ui/util'
import { formatDate } from '../lib/studioEngine'
import { Workflow, Database, FileText, ClipboardCheck, CircleDot, Zap } from '../ui/icons'

export function ProcessPage() {
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
