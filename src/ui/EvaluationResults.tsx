import { useState } from 'react'
import { ENVIRONMENT } from '../types'
import type { EmailDraft } from '../types'
import { downloadText, formatDate } from '../lib/studioEngine'
import { evaluationEvidence } from '../lib/evaluationEvidence'
import { useApp } from './studioContext'
import { Badge, Button, Card, CardHeader, EmptyState, Field, SelectInput, TextArea } from './primitives'
import { InlineNote } from './Banners'
import { Download, RefreshCw } from './icons'

const SEND_LABELS: Record<EmailDraft['state'], string> = {
  draft: 'Not sent', sending: 'Submitting', sent: 'Submission recorded',
  failed: 'Send failed', unknown: 'Outcome uncertain', cancelled: 'Cancelled',
}
const VERDICT_LABELS = { unscored: 'Not assessed', pass: 'Pass', fail: 'Fail' }

export function EvaluationResults({ currentDraftId }: { currentDraftId?: string }) {
  const { studio } = useApp()
  const { state, actions } = studio
  const [selection, setSelection] = useState<{ id: string; currentDraftId?: string }>()
  const [edits, setEdits] = useState<Record<string, { verdict: 'pass' | 'fail' | 'unscored'; notes: string }>>({})
  const drafts = state.drafts
  const selectedId = selection?.currentDraftId === currentDraftId ? selection?.id : currentDraftId
  const selected = drafts.find(item => item.id === (selectedId ?? currentDraftId)) ?? drafts.at(-1)
  const observed = selected ? evaluationEvidence(selected, state.snapshot, ENVIRONMENT.helpMailbox) : undefined
  const edit = selected ? edits[selected.id] ?? { verdict: selected.evaluationVerdict ?? 'unscored', notes: selected.evaluationNotes ?? '' } : undefined
  const dirty = selected && edit && (edit.verdict !== (selected.evaluationVerdict ?? 'unscored') || edit.notes !== (selected.evaluationNotes ?? ''))
  const unsaved = drafts.some(item => edits[item.id] && (
    edits[item.id].verdict !== (item.evaluationVerdict ?? 'unscored') || edits[item.id].notes !== (item.evaluationNotes ?? '')
  ))
  const patch = (change: Partial<NonNullable<typeof edit>>) => {
    if (selected && edit) setEdits(previous => ({ ...previous, [selected.id]: { ...edit, ...change } }))
  }
  const preview = state.settings.mode === 'preview'
  const inboxHealthy = state.snapshot.health.some(item => item.source === `Inbox: ${ENVIRONMENT.helpMailbox}` && item.status === 'healthy')
  const caseHealthy = ['Cases', 'Case notes'].every(source => state.snapshot.health.some(item => item.source === source && item.status === 'healthy'))
  const exact = observed?.method === 'legacy-token'
  const exportReport = () => downloadText('gravity-evaluation-report.json', JSON.stringify({
    mode: state.settings.mode, exportedAt: new Date().toISOString(),
    scope: 'Saved session verdicts are manual. Natural-subject matches are candidates, not confirmed correlation or processing success. Only legacy subject tokens support exact-token matching.',
    monitoredMailbox: ENVIRONMENT.helpMailbox,
    snapshot: { fetchedAt: state.snapshot.fetchedAt, health: state.snapshot.health, limitations: state.snapshot.truncated },
    tests: drafts.map(draft => ({ ...draft, observed: evaluationEvidence(draft, state.snapshot, ENVIRONMENT.helpMailbox) })),
  }, null, 2), 'application/json')

  return (
    <Card className="evaluation-results">
      <CardHeader
        label="3 · Evaluate"
        title="Review the outcome"
        description="Choose a test, inspect the available evidence, then record your own verdict."
        actions={<Button size="sm" icon={<Download size={14} />} disabled={!drafts.length} onClick={exportReport}>Export saved report</Button>}
      />
      {!selected || !edit || !observed ? (
        <EmptyState title="Your tests will appear here" description="Create a draft above or in Campaigns. After sending, compare the expected behaviour with incoming mail and case evidence. Nothing is scored automatically." />
      ) : (
        <div className="evaluation-results__content">
          <div className="evaluation-results__selection">
            <Field label="Test to review" htmlFor="evaluate-test">
              <SelectInput id="evaluate-test" value={selected.id} onChange={event => setSelection({ id: event.target.value, currentDraftId })}>
                {drafts.map((item, index) => (
                  <option key={item.id} value={item.id}>
                    {index + 1}. {state.snapshot.customers.find(customer => customer.id === item.customerId)?.name || item.from} — {item.subject}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Button size="sm" icon={<RefreshCw size={14} />} disabled={state.refreshing} onClick={() => void actions.refresh()}>
              {state.refreshing ? 'Refreshing…' : 'Refresh evidence'}
            </Button>
          </div>
          <p className="muted-note evaluation-results__sender">
            From {selected.from} · {state.snapshot.fetchedAt ? `Snapshot ${formatDate(state.snapshot.fetchedAt)}` : 'No snapshot yet'}
          </p>

          <div className="evaluation-results__evidence" aria-label="Observed evidence">
            <section className="evaluation-evidence">
              <h3>Submission</h3>
              <Badge tone={selected.state === 'unknown' ? 'warning' : selected.state === 'failed' ? 'danger' : 'neutral'}>
                {SEND_LABELS[selected.state]}
              </Badge>
              <p>{preview ? 'Preview does not send emails or run the live workflow.'
                : selected.state === 'sent' ? 'A connector acknowledgement or manual reconciliation is recorded. This is not delivery proof.'
                  : selected.state === 'unknown' ? 'Inspect the mailboxes before retrying. The original email may have been submitted.'
                    : selected.state === 'sending' ? 'Waiting for the connector. Do not submit this email again.'
                      : 'Send the reviewed draft before looking for live results.'}</p>
            </section>
            <section className="evaluation-evidence">
              <h3>Help inbox</h3>
              <Badge tone={observed.inbox.length ? (exact && inboxHealthy ? 'success' : 'warning') : 'neutral'}>
                {preview ? 'Preview only' : !inboxHealthy ? 'Source unavailable'
                  : observed.inbox.length ? `${observed.inbox.length} ${exact ? 'token match' : 'possible match'}${observed.inbox.length === 1 ? '' : 'es'}`
                    : selected.state === 'draft' || selected.state === 'cancelled' ? 'Not sent' : 'No match observed'}
              </Badge>
              <p>{exact ? 'The sender and legacy subject token match loaded Help Inbox messages.'
                : 'Same sender and subject near submission time. Open Communications to confirm the actual email.'}</p>
            </section>
            <section className="evaluation-evidence">
              <h3>Dataverse cases</h3>
              <Badge tone={observed.cases.length ? (exact && caseHealthy ? 'success' : 'warning') : 'neutral'}>
                {preview ? 'Preview only' : !caseHealthy ? 'Source unavailable'
                  : observed.cases.length ? `${observed.cases.length} ${exact ? 'token match' : 'possible match'}${observed.cases.length === 1 ? '' : 'es'}` : 'No match observed'}
              </Badge>
              <p>{exact ? 'The customer and legacy token match a case or its notes. A linked case does not prove the request was completed.'
                : 'Same customer and case title near submission time. A possible case is not proof of correct handling.'}</p>
            </section>
          </div>

          {observed.inbox.length || observed.cases.length ? (
            <div className="evaluation-results__matches">
              <h3>{exact ? 'Records containing the legacy token' : 'Possible matches to inspect'}</h3>
              <ul>
                {observed.inbox.map(item => <li key={item.id}><span>Help inbox · {formatDate(item.receivedAt)}</span><strong>{item.subject}</strong></li>)}
                {observed.cases.map(item => (
                  <li key={item.id}>
                    <a href={`${ENVIRONMENT.url}/main.aspx?pagetype=entityrecord&etn=incident&id=${encodeURIComponent(item.id)}`} target="_blank" rel="noreferrer">
                      {item.number} · {item.title}
                    </a>
                    <span>{item.category} · {item.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <InlineNote tone={preview ? 'info' : 'warning'}>
            {preview ? 'Preview is for practising the review process; fixture data is not evidence that this test ran.'
              : 'Missing evidence does not mean failure. Natural subjects have no tracking code, so possible matches always need human confirmation.'}
            {!preview && (!inboxHealthy || !caseHealthy || state.snapshot.truncated.length > 0) ? ' Some sources are unavailable, stale or capped; observations are incomplete.' : ''}
          </InlineNote>

          <div className="evaluation-results__review">
            <section className="evaluation-expected">
              <h3>Expected behaviour</h3>
              <p className="evaluation-expected__body">{selected.expectedOutcome}</p>
              <p className="muted-note">This is the test target, not an observed result. Compare it with the actual response and case handling.</p>
            </section>
            <section className="evaluation-verdict">
              <h3>Your assessment</h3>
              <Field label="Verdict" htmlFor="eval-verdict" hint="Choose Pass only after confirming the expected behaviour. Otherwise leave it Not assessed.">
                <SelectInput id="eval-verdict" value={edit.verdict} onChange={event => patch({
                  verdict: event.target.value === 'pass' ? 'pass' : event.target.value === 'fail' ? 'fail' : 'unscored',
                })}>
                  <option value="unscored">Not assessed</option>
                  <option value="pass">Pass — expected behaviour confirmed</option>
                  <option value="fail">Fail — behaviour differs from expected</option>
                </SelectInput>
              </Field>
              <Field label="What did you observe?" htmlFor="eval-notes">
                <TextArea id="eval-notes" rows={4} value={edit.notes} placeholder="Describe the response, relevant case, missing steps or reason for your verdict."
                  onChange={event => patch({ notes: event.target.value })} />
              </Field>
              <div className="evaluation-verdict__save">
                <Button variant="primary" size="sm" disabled={!dirty && selected.evaluationVerdict !== undefined}
                  onClick={() => actions.recordEvaluation(selected.id, edit.verdict, edit.notes)}>Save assessment</Button>
                <span className="muted-note" role="status">
                  {dirty ? 'Unsaved changes' : selected.evaluationVerdict ? `Saved in this tab: ${VERDICT_LABELS[selected.evaluationVerdict]}` : 'No assessment saved'}
                </span>
              </div>
            </section>
          </div>
          <details className="evaluation-results__scope">
            <summary>How matching works and what is not measured</summary>
            <p>New emails have natural subjects with no hidden or visible test marker. Possible inbox matches use the same sender and exact subject; possible cases use the same customer and exact title. Both use a window from one minute before to fifteen minutes after connector acknowledgement. Repeated subjects can match several tests. Renamed cases, delayed results and sends without an acknowledgement time need manual inspection. Legacy marked subjects still use token matching.</p>
            <p>Only loaded Help Inbox messages and Dataverse records are inspected. Customer alias inboxes, agent classification, flow timings and actual business completion are not measured here. A successful submission or a case is not an automatic pass.</p>
          </details>
          <p className="evaluation-results__retention">
            Assessments stay in this tab only. Export the saved report before reloading or closing.
            {unsaved ? ' Unsaved edits are not included in the export.' : ''}
          </p>
        </div>
      )}
    </Card>
  )
}
