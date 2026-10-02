import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import {
  Background, BaseEdge, getSmoothStepPath, Handle, MarkerType, Position, ReactFlow,
} from '@xyflow/react'
import type { Edge, EdgeProps, Node, NodeProps, ReactFlowInstance } from '@xyflow/react'
import { ArrowRight, Bot, BriefcaseBusiness, CheckCircle2, ExternalLink, Inbox, Layers, ListChecks, MailCheck, Minus, Plus, Scan, Send, Tags, X } from 'lucide-react'
import { Modal } from './Modal'
import type {
  ProcessDefinition, ProcessEvent, ProcessLink, ProcessSnapshot, ProcessStageDefinition, ProcessState, StageExecution,
} from '../process/types'
import {
  PROCESS_STATE_LABELS, PROCESS_STATE_MARKS, processDuration, processTime, stageState,
} from '../process/definition'
import '@xyflow/react/dist/style.css'
import '../process/process.css'

type SummaryNode = Node<{
  title: string
  eyebrow: string
  detail: string
  icon: 'mailbox' | 'classifier' | 'agent' | 'case' | 'outcome' | 'response'
  state: ProcessState
  configuration: boolean
  metrics: string[]
  stageCode?: string
  active: boolean
  onSelect: (stageCode?: string) => void
}, 'summary'>

const summaryIcon = {
  mailbox: Inbox,
  classifier: Tags,
  agent: Bot,
  case: BriefcaseBusiness,
  outcome: CheckCircle2,
  response: Send,
}

function SummaryShape({ data }: NodeProps<SummaryNode>) {
  const Icon = summaryIcon[data.icon]
  const label = data.configuration ? 'Configured step' : PROCESS_STATE_LABELS[data.state]
  return (
    <div className={`process-summary-node process-summary-node--${data.icon}${data.active ? ' is-selected' : ''}`}>
      <Handle type="target" id="in" position={Position.Left} isConnectable={false} />
      <Handle type="source" id="out" position={Position.Right} isConnectable={false} />
      <button
        type="button"
        className="process-summary-node__button nodrag nopan"
        onClick={() => data.onSelect(data.stageCode)}
        aria-label={`${data.title}. ${label}${data.stageCode ? '. Inspect stage' : ''}`}
        aria-pressed={data.active}
        disabled={!data.stageCode}
      >
        <span className="process-summary-node__top">
          <span className="process-summary-node__icon" aria-hidden="true"><Icon size={19} /></span>
          <span className="process-summary-node__eyebrow">{data.eyebrow}</span>
        </span>
        <span className="process-summary-node__title">{data.title}</span>
        <span className="process-summary-node__detail">{data.detail}</span>
        <span className={`process-status process-status--${data.configuration ? 'unknown' : data.state}`}>
          <span aria-hidden="true">{data.configuration ? '◇' : PROCESS_STATE_MARKS[data.state]}</span>{label}
        </span>
        <span className="process-summary-node__metrics">
          {data.metrics.map(metric => <span key={metric}>{metric}</span>)}
        </span>
      </button>
    </div>
  )
}

const nodeTypes = { summary: SummaryShape }

function ProcessEdge(props: EdgeProps<Edge<{ route?: string }>>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props
  let [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 7, offset: 20 })
  let rotation = 0
  if (data?.route === 'reopen') {
    const outerX = Math.max(sourceX, targetX) + 48
    path = `M ${sourceX},${sourceY} H ${outerX} V ${targetY} H ${targetX}`
    labelX = outerX + 12
    labelY = (sourceY + targetY) / 2
    rotation = 90
  } else if (data?.route === 'resolved') {
    const outerX = Math.max(sourceX, targetX) + 78
    path = `M ${sourceX},${sourceY} H ${outerX} V ${targetY} H ${targetX}`
    labelX = outerX + 12
    labelY = (sourceY + targetY) / 2
    rotation = 90
  } else {
    labelY -= Math.abs(sourceY - targetY) < 15 ? 65 : 0
  }
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} />
      {rotation ? <text className="process-edge-label" transform={`translate(${labelX},${labelY}) rotate(${rotation})`} textAnchor="middle">{props.label}</text>
        : <BaseEdge path="" label={props.label} labelX={labelX} labelY={labelY} labelStyle={props.labelStyle} labelBgStyle={props.labelBgStyle} labelBgPadding={[5, 3]} />}
    </>
  )
}

const edgeTypes = { process: ProcessEdge }

function ProcessFlowDiagram({
  nodes,
  edges,
  compact,
  expanded,
  onSelect,
  instanceRef,
}: {
  nodes: SummaryNode[]
  edges: Edge[]
  compact: boolean
  expanded?: boolean
  onSelect: () => void
  instanceRef: MutableRefObject<ReactFlowInstance<SummaryNode, Edge> | null>
}) {
  return (
    <div className={`process-diagram${expanded ? ' process-diagram--expanded' : ''}`} aria-label="Read-only process flow diagram">
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={flow => { instanceRef.current = flow }}
        fitView fitViewOptions={{ padding: expanded ? 0.16 : compact ? 0.08 : 0.12 }} minZoom={0.35} maxZoom={1.7}
        nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false}
        elementsSelectable={false} deleteKeyCode={null} selectionOnDrag={false} zoomOnDoubleClick={false}
        zoomOnScroll={expanded} panOnScroll={expanded} preventScrolling={!expanded}
        onPaneClick={onSelect}
      >
        <Background gap={20} size={1} color="var(--cp-border)" />
      </ReactFlow>
    </div>
  )
}

export function ProcessRecordLinks({ links }: { links: ProcessLink[] }) {
  if (!links.length) return <p className="process-muted">No native record reference reported.</p>
  return (
    <ul className="process-records">
      {links.map((link, index) => {
        let safe = false
        try {
          const parsed = new URL(link.url ?? '')
          safe = parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
            ['dynamics.com', 'powerapps.com', 'powerautomate.com', 'copilotstudio.microsoft.com', 'outlook.office.com', 'dynamics.cn', 'microsoftdynamics.us', 'appsplatform.us'].some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))
        } catch { /* A missing or invalid URL remains an inert record reference. */ }
        return (
          <li key={`${link.kind}-${link.recordId ?? index}`}>
            {safe ? <a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}<ExternalLink size={13} aria-label="Opens in a new tab" /></a> : <span>{link.label}</span>}
            <small>{link.kind}{link.recordId ? ` · ${link.recordId}` : ''}{!safe ? ' · link unavailable' : ''}</small>
          </li>
        )
      })}
    </ul>
  )
}

export function ProcessEventTimeline({ events }: { events: ProcessEvent[] }) {
  const ordered = useMemo(() => [...events].sort((a, b) => b.projectionRevision - a.projectionRevision || b.recordedAt.localeCompare(a.recordedAt)), [events])
  if (!ordered.length) return <p className="process-empty">No events reported in this page. Absence is not success.</p>
  return (
    <ol className="process-events">
      {ordered.map(event => (
        <li key={event.eventId}>
          <div className="process-events__heading"><strong>{event.eventType}</strong><span>Revision {event.projectionRevision}</span></div>
          <p>{event.stageCode ?? 'Process'}{event.outcome ? ` · ${event.outcome}` : ''}</p>
          <dl className="process-facts">
            <div><dt>Occurred</dt><dd>{processTime(event.occurredAt)}</dd></div>
            <div><dt>Recorded</dt><dd>{processTime(event.recordedAt)}</dd></div>
            <div><dt>Source</dt><dd>{event.source}{event.sourceVersion ? ` · v${event.sourceVersion}` : ''}</dd></div>
          </dl>
          {event.links.length ? <ProcessRecordLinks links={event.links} /> : null}
        </li>
      ))}
    </ol>
  )
}

function StageDetails({ stage, executions, events, configuration, onClose }: {
  stage: ProcessStageDefinition
  executions: StageExecution[]
  events: ProcessEvent[]
  configuration: boolean
  onClose: () => void
}) {
  const [showInternals, setShowInternals] = useState(false)
  const headingId = useId()
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const origin = document.activeElement
    closeButton.current?.focus({ preventScroll: true })
    return () => { if (origin instanceof HTMLElement && origin.isConnected) origin.focus({ preventScroll: true }) }
  }, [])
  return (
    <aside className="process-details" aria-labelledby={headingId} onKeyDown={event => { if (event.key === 'Escape') onClose() }}>
      <div className="process-details__head">
        <div><span className="process-eyebrow">{stage.phase} · {stage.kind}</span><h3 id={headingId}>{stage.label}</h3></div>
        <button ref={closeButton} type="button" className="process-icon-button" aria-label="Close stage details" onClick={onClose}><X size={17} /></button>
      </div>
      <p>{stage.description}</p>
      <dl className="process-facts">
        <div><dt>Coverage</dt><dd>{stage.coverage}</dd></div>
        <div><dt>Policy</dt><dd>{stage.optional ? 'Conditional / optional' : 'Required'}</dd></div>
        <div><dt>Evidence</dt><dd>{stage.evidence === 'lifecycle' ? 'Case lifecycle overlay · not an inspected flow action' : configuration ? 'Configuration inventory · not execution' : 'Ledger facts only'}</dd></div>
      </dl>
      {stage.opaque ? (
        <div className="process-callout">
          <button type="button" className="process-text-button" onClick={() => setShowInternals(value => !value)} aria-expanded={showInternals}>
            {showInternals ? <Minus size={14} /> : <Plus size={14} />} {showInternals ? 'Collapse' : 'Expand'} subprocess information
          </button>
          {showInternals ? <p>Internal steps are not instrumented. Identification and tool actions are not separate observed stages. No identity result, action duration, token use or internal order is inferred.</p> : <p>Only the outer invocation can be shown.</p>}
        </div>
      ) : null}
      <h4>Execution attempts <span>{executions.length}</span></h4>
      {executions.length === 0 ? <p className="process-empty">{configuration ? 'Configuration view has no execution telemetry.' : 'No execution reported. Not started, skipped and succeeded cannot be inferred.'}</p> : (
        <ol className="process-attempts">
          {[...executions].sort((a, b) => a.attempt - b.attempt || (a.recordedAt ?? '').localeCompare(b.recordedAt ?? '') || a.stageExecutionId.localeCompare(b.stageExecutionId)).map(execution => (
            <li key={execution.stageExecutionId}>
              <div className="process-attempts__heading"><strong>Attempt {execution.attempt}</strong><span className={`process-status process-status--${execution.state}`}><span aria-hidden="true">{PROCESS_STATE_MARKS[execution.state]}</span>{PROCESS_STATE_LABELS[execution.state]}</span></div>
              <dl className="process-facts">
                <div><dt>Branch / scope</dt><dd>{execution.branch ?? 'Main'}</dd></div>
                <div><dt>Source</dt><dd>{execution.source}{execution.sourceVersion ? ` · v${execution.sourceVersion}` : ''}</dd></div>
                <div><dt>Occurred</dt><dd>{processTime(execution.occurredAt)}</dd></div>
                <div><dt>Recorded</dt><dd>{execution.recordedAt ? processTime(execution.recordedAt) : 'Unavailable on stage snapshot · see event history'}</dd></div>
                <div><dt>Started</dt><dd>{processTime(execution.startedAt)}</dd></div>
                <div><dt>Ended</dt><dd>{processTime(execution.endedAt)}</dd></div>
                <div><dt>Duration</dt><dd>{processDuration(execution, stage.kind === 'wait')}</dd></div>
                {execution.errorCode ? <div><dt>Error code</dt><dd>{execution.errorCode}</dd></div> : null}
                <div><dt>Span ID</dt><dd className="process-mono">{execution.stageExecutionId}</dd></div>
              </dl>
              <ProcessRecordLinks links={execution.links} />
            </li>
          ))}
        </ol>
      )}
      <h4>Stage events</h4>
      <ProcessEventTimeline events={events} />
    </aside>
  )
}

export interface ProcessCanvasProps {
  definition: ProcessDefinition
  snapshot?: ProcessSnapshot
  events?: ProcessEvent[]
  compact?: boolean
}

export function ProcessCanvas({ definition, snapshot, events = [], compact = false }: ProcessCanvasProps) {
  const [view, setView] = useState<'diagram' | 'list'>('diagram')
  const [selectedCode, setSelectedCode] = useState<string>()
  const [expanded, setExpanded] = useState(false)
  const instanceRef = useRef<ReactFlowInstance<SummaryNode, Edge> | null>(null)
  const expandedInstance = useRef<ReactFlowInstance<SummaryNode, Edge> | null>(null)
  const selected = definition.stages.find(stage => stage.stageCode === selectedCode)
  const configuration = !snapshot
  const stages = useMemo(() => [...definition.stages].sort((a, b) => a.order - b.order), [definition.stages])
  const executions = snapshot?.stages
  const stageByCode = useMemo(() => new Map(definition.stages.map(stage => [stage.stageCode, stage])), [definition.stages])
  const summarySteps = useMemo(() => {
    const preferredStage = (...codes: string[]) => codes.find(code => stageByCode.has(code))
    const matchingExecutions = (...codes: string[]) => (executions ?? []).filter(execution => codes.includes(execution.stageCode))
    const matchingEvents = (...codes: string[]) => events.filter(event => event.stageCode && codes.includes(event.stageCode))
    const latestActivity = (codes: string[]) => {
      const candidates = [
        ...matchingExecutions(...codes).flatMap(execution => [execution.recordedAt, execution.occurredAt, execution.endedAt, execution.startedAt]),
        ...matchingEvents(...codes).flatMap(event => [event.recordedAt, event.occurredAt]),
      ].filter((value): value is string => Boolean(value))
      const latest = candidates.map(value => new Date(value)).filter(date => !Number.isNaN(date.getTime())).sort((a, b) => b.getTime() - a.getTime())[0]
      return latest ? `Latest ${latest.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : 'No execution yet'
    }
    const metricsFor = (...codes: string[]) => {
      if (!snapshot) return ['No live executions']
      const count = matchingExecutions(...codes).length
      return [`${count} execution${count === 1 ? '' : 's'}`, latestActivity(codes)]
    }
    const selectedAgent = () => {
      const ranked = [
        { codes: ['card-servicing', 'card-service'], label: 'Selected: Card Servicing' },
        { codes: ['mock-response'], label: 'Selected: Mock Response' },
        { codes: ['spam', 'default-response'], label: 'Selected: SPAM/default' },
      ]
      for (const candidate of ranked) {
        if (matchingExecutions(...candidate.codes).length || matchingEvents(...candidate.codes).length) return candidate.label
      }
      const route = matchingExecutions('route').find(execution => execution.branch)?.branch
      return route ? `Selected: ${route}` : 'Selection pending'
    }
    const selectedClassifierRoute = () => {
      const route = matchingExecutions('route').find(execution => execution.branch)?.branch
      return route ? `Route: ${route}` : 'Route pending'
    }
    const stateForCodes = (...codes: string[]) => {
      const code = preferredStage(...codes)
      if (!code) return 'unknown' as ProcessState
      return stageState(stageByCode.get(code)!, executions ?? [])
    }
    return [
      {
        id: 'shared-mailbox', title: 'Shared Mailbox', eyebrow: 'Intake',
        detail: 'Help mailbox receives the customer email and starts tracking.',
        icon: 'mailbox' as const, stageCode: preferredStage('intake'), state: stateForCodes('intake'),
        metrics: metricsFor('intake'),
      },
      {
        id: 'classifier', title: 'Classifier', eyebrow: 'Classify',
        detail: 'Classifies the request and chooses the next handling route.',
        icon: 'classifier' as const, stageCode: preferredStage('classify', 'route'), state: stateForCodes('classify', 'route'),
        metrics: [...metricsFor('classify', 'route'), selectedClassifierRoute()],
      },
      {
        id: 'agent', title: 'Agent', eyebrow: 'Action',
        detail: 'Card Servicing agent prepares the servicing recommendation.',
        icon: 'agent' as const, stageCode: preferredStage('card-servicing', 'card-service'), state: stateForCodes('card-servicing', 'card-service'),
        metrics: [...metricsFor('card-servicing', 'card-service', 'mock-response', 'spam', 'default-response'), selectedAgent()],
      },
      {
        id: 'case-management', title: 'Case Management', eyebrow: 'Case',
        detail: 'Creates, links or waits on a case when human handling is needed.',
        icon: 'case' as const, stageCode: preferredStage('reviewcase', 'human-review'), state: stateForCodes('reviewcase', 'human-review'),
        metrics: [...metricsFor('reviewcase', 'human-review'), `${snapshot?.cases.length ?? 0} linked case${snapshot?.cases.length === 1 ? '' : 's'}`],
      },
      {
        id: 'outcome', title: 'Outcome', eyebrow: 'Decision',
        detail: 'The request is resolved, waiting, failed or needs reconciliation.',
        icon: 'outcome' as const, stageCode: preferredStage('completed', 'exception', 'reviewcase'), state: snapshot?.state ?? stateForCodes('completed', 'exception', 'reviewcase'),
        metrics: snapshot ? [`Process ${PROCESS_STATE_LABELS[snapshot.state]}`, `Revision ${snapshot.projectionRevision}`] : ['Outcome pending'],
      },
      {
        id: 'email-response', title: 'Email Response', eyebrow: 'Response',
        detail: 'Approved response or default handling is sent back to the customer.',
        icon: 'response' as const, stageCode: preferredStage('mock-response', 'default-response', 'spam'), state: stateForCodes('mock-response', 'default-response', 'spam'),
        metrics: metricsFor('mock-response', 'default-response', 'spam'),
      },
    ]
  }, [stageByCode, executions, events, snapshot])
  const summaryNodes: SummaryNode[] = useMemo(() => summarySteps.map((step, index) => ({
    id: step.id,
    type: 'summary',
    position: { x: 40 + index * 280, y: index % 2 === 0 ? 70 : 150 },
    selectable: false,
    draggable: false,
    focusable: false,
    data: {
      ...step,
      configuration,
      active: Boolean(step.stageCode && selectedCode === step.stageCode),
      onSelect: code => { if (code) setSelectedCode(code) },
    },
  })), [summarySteps, configuration, selectedCode])
  const summaryEdges: Edge[] = useMemo(() => summarySteps.slice(0, -1).map((step, index) => ({
    id: `${step.id}-${summarySteps[index + 1].id}`,
    source: step.id,
    target: summarySteps[index + 1].id,
    type: 'process',
    className: 'process-edge process-edge--summary',
    style: { stroke: 'var(--cp-text-subtle)', strokeWidth: 1.7 },
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'var(--cp-text-subtle)' },
    focusable: false,
    selectable: false,
    animated: false,
  })), [summarySteps])
  return (
    <div className={`process-canvas${compact ? ' process-canvas--compact' : ''}${view === 'list' ? ' process-canvas--list' : ''}`}>
      <div className="process-canvas__toolbar">
        <div className="process-view-switch" aria-label="Process presentation">
          <button type="button" aria-pressed={view === 'diagram'} onClick={() => setView('diagram')}><Layers size={14} /> Flow</button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}><ListChecks size={14} /> Stage list</button>
        </div>
        <span className={`process-mode process-mode--${snapshot?.mode ?? definition.mode}`}>{snapshot?.mode === 'synthetic' ? 'Synthetic walkthrough' : snapshot ? 'Ledger snapshot' : 'Configuration only'}</span>
        <div className="process-zoom" aria-label="Diagram zoom">
          <button type="button" className="process-icon-button" aria-label="Zoom out" onClick={() => void instanceRef.current?.zoomOut({ duration: 0 })}><Minus size={15} /></button>
          <button type="button" className="process-icon-button" aria-label="Zoom in" onClick={() => void instanceRef.current?.zoomIn({ duration: 0 })}><Plus size={15} /></button>
          <button type="button" className="process-icon-button" aria-label="Fit diagram to view" onClick={() => void instanceRef.current?.fitView({ padding: 0.035, duration: 0 })}><Scan size={15} /></button>
          <button type="button" className="process-expand-button" onClick={() => setExpanded(true)}>Expand map</button>
        </div>
      </div>
      <div className="process-canvas__body">
        <ProcessFlowDiagram nodes={summaryNodes} edges={summaryEdges} compact={compact} onSelect={() => setSelectedCode(undefined)} instanceRef={instanceRef} />
        <div className="process-stage-list">
          <p className="process-muted">Definition order is for navigation, not a claim of serial execution. Branch routes are listed under each stage.</p>
          <ol>
            {stages.map(stage => {
              const state = stageState(stage, executions ?? [])
              return (
                <li key={stage.stageCode}>
                  <button type="button" className={selectedCode === stage.stageCode ? 'is-selected' : ''} onClick={() => setSelectedCode(stage.stageCode)} aria-pressed={selectedCode === stage.stageCode}>
                    <span className="process-stage-list__mark" aria-hidden="true">{configuration ? '◇' : PROCESS_STATE_MARKS[state]}</span>
                    <span><strong>{stage.label}</strong><small>{definition.lanes.find(lane => lane.id === stage.laneId)?.label ?? stage.laneId} · {stage.phase}</small></span>
                    <span className={`process-status process-status--${state}`}>{configuration ? 'Config only' : PROCESS_STATE_LABELS[state]}</span>
                  </button>
                  <ul className="process-routes">
                    {definition.transitions.filter(edge => edge.fromStageCode === stage.stageCode).map(edge => (
                      <li key={edge.transitionCode}><ArrowRight size={12} aria-hidden="true" />{edge.label} → {definition.stages.find(target => target.stageCode === edge.toStageCode)?.label ?? edge.toStageCode}</li>
                    ))}
                  </ul>
                </li>
              )
            })}
          </ol>
        </div>
        {selected ? <StageDetails key={selected.stageCode} stage={selected} configuration={configuration} executions={(executions ?? []).filter(item => item.stageCode === selected.stageCode)} events={events.filter(event => event.stageCode === selected.stageCode)} onClose={() => setSelectedCode(undefined)} /> : null}
      </div>
      <div className="process-canvas__legend">
        <span><MailCheck size={13} /> Simple business flow</span>
        <span><i className="process-legend-line" /> Main route</span>
        <span>◇ Configured step</span>
        <span>? Missing telemetry is unknown</span>
      </div>
      <Modal
        open={expanded}
        onClose={() => setExpanded(false)}
        size="fullscreen"
        title="Process map"
        description="Expanded read-only view of the same six-node process map. Close to return to the dashboard."
      >
        <div className="process-expanded-map">
          <ProcessFlowDiagram nodes={summaryNodes} edges={summaryEdges} compact={false} expanded onSelect={() => setSelectedCode(undefined)} instanceRef={expandedInstance} />
        </div>
      </Modal>
    </div>
  )
}
