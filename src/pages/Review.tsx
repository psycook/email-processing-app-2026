import { useMemo, useState } from 'react'
import type { ReviewChange } from '../types'
import { ENVIRONMENT } from '../types'
import { formatDate } from '../lib/studioEngine'
import { useApp } from '../ui/studioContext'
import {
  Card,
  CardHeader,
  SectionLabel,
  Badge,
  Button,
  Field,
  SelectInput,
  TextArea,
  Segmented,
  EmptyState,
  Spinner,
  MetaRow,
} from '../ui/primitives'
import { InlineNote } from '../ui/Banners'
import { Modal } from '../ui/Modal'
import {
  openCases,
  sortCasesByModified,
  customerById,
  notesForCase,
  tasksForCase,
} from '../ui/selectors'
import { REVIEW_STATUS_OPTIONS, PRIORITY_OPTIONS, priorityLabel, priorityTone } from '../ui/constants'
import { cx } from '../ui/util'
import { ClipboardCheck, Search, ExternalLink, FileText, ListChecks, Users } from '../ui/icons'

function statusLabel(code: number): string {
  return REVIEW_STATUS_OPTIONS.find((option) => option.value === code)?.label ?? `Status ${code}`
}

export function ReviewPage() {
  const { studio, ui } = useApp()
  const { state, actions } = studio
  const { snapshot } = state

  const open = useMemo(() => sortCasesByModified(openCases(snapshot)), [snapshot])
  const [query, setQuery] = useState('')
  const [priorityFilter, setPriorityFilter] = useState<'all' | '1' | '2' | '3'>('all')
  const [selectedId, setSelectedId] = useState<string>('')
  const [edits, setEdits] = useState<Record<string, Partial<ReviewChange>>>({})
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    return open.filter((item) => {
      if (priorityFilter !== 'all' && String(item.priority) !== priorityFilter) return false
      if (!term) return true
      return (
        item.title.toLowerCase().includes(term) ||
        item.number.toLowerCase().includes(term) ||
        item.owner.toLowerCase().includes(term)
      )
    })
  }, [open, query, priorityFilter])

  const current = filtered.find((item) => item.id === selectedId) ?? filtered[0] ?? null
  const caseCustomer = current ? customerById(snapshot, current.customerId) : undefined

  const defaultStatus = (code: number): number =>
    REVIEW_STATUS_OPTIONS.some((option) => option.value === code) ? code : REVIEW_STATUS_OPTIONS[0].value

  const edit: ReviewChange = current
    ? {
        priority: edits[current.id]?.priority ?? current.priority,
        statusCode: edits[current.id]?.statusCode ?? defaultStatus(current.statusCode),
        note: edits[current.id]?.note ?? '',
      }
    : { priority: 2, statusCode: 1, note: '' }

  const patchEdit = (patch: Partial<ReviewChange>) => {
    if (!current) return
    setEdits((prev) => ({ ...prev, [current.id]: { ...prev[current.id], ...patch } }))
  }

  const dirty =
    !!current &&
    (edit.priority !== current.priority ||
      edit.statusCode !== defaultStatus(current.statusCode) ||
      edit.note.trim().length > 0)

  const doSave = async () => {
    if (!current) return
    setSaving(true)
    setSaveError(undefined)
    try {
      await actions.saveReview(current.id, edit)
      setConfirmOpen(false)
      setEdits((prev) => {
        const next = { ...prev }
        delete next[current.id]
        return next
      })
      actions.notify(`Case ${current.number} updated`, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save the review.'
      setSaveError(message)
      actions.notify(message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const recordUrl = current
    ? `${ENVIRONMENT.url}/main.aspx?pagetype=entityrecord&etn=incident&id=${encodeURIComponent(current.id)}`
    : '#'

  return (
    <div className="page">
      <section className="page-head">
        <div>
          <SectionLabel>Human review</SectionLabel>
          <h1 className="page-title">Open case review</h1>
          <p className="page-lede">
            Every open case in scope, shown for a person to check and update. This list is the full set of open cases —
            it is not an AI confidence flag.
          </p>
        </div>
      </section>

      <div className="review-layout">
        <Card className="review-list-card">
          <div className="review-filters">
            <div className="customers-search">
              <span aria-hidden="true"><Search size={15} /></span>
              <input
                type="search"
                aria-label="Search cases"
                placeholder="Search title, number or owner…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Segmented
              ariaLabel="Priority filter"
              size="sm"
              value={priorityFilter}
              onChange={setPriorityFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: '1', label: 'High' },
                { value: '2', label: 'Normal' },
                { value: '3', label: 'Low' },
              ]}
            />
          </div>
          {filtered.length === 0 ? (
            <EmptyState icon={<ClipboardCheck size={20} />} title="No open cases" description="Nothing needs review in the current snapshot and filters." />
          ) : (
            <ul className="review-list">
              {filtered.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={cx('review-row', current?.id === item.id && 'review-row--active')}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className="review-row__main">
                      <span className="review-row__title">{item.title || item.number}</span>
                      <span className="review-row__meta">{item.number} · {statusLabel(item.statusCode)}</span>
                    </span>
                    <Badge soft tone={priorityTone(item.priority)}>{priorityLabel(item.priority)}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="review-detail">
          {!current ? (
            <Card>
              <EmptyState icon={<ClipboardCheck size={22} />} title="Select a case" description="Choose a case to review and update." />
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader
                  label={`Case ${current.number}`}
                  title={current.title || 'Untitled case'}
                  actions={
                    <a className="btn btn--subtle btn--sm" href={recordUrl} target="_blank" rel="noopener noreferrer">
                      <span className="btn__icon"><ExternalLink size={14} /></span>
                      <span className="btn__label">Open record</span>
                    </a>
                  }
                />
                {current.description ? <p className="case-desc">{current.description}</p> : null}
                <MetaRow
                  items={[
                    {
                      label: (<><Users size={13} /> Customer</>),
                      value: caseCustomer ? (
                        <button type="button" className="link-btn" onClick={() => { ui.selectCustomer(current.customerId); actions.navigate('customers') }}>
                          {caseCustomer.name}
                        </button>
                      ) : '—',
                    },
                    { label: 'Category', value: current.category || '—' },
                    { label: 'Owner', value: current.owner || '—' },
                    { label: 'Created', value: formatDate(current.createdAt) },
                    { label: 'Updated', value: formatDate(current.modifiedAt) },
                    { label: 'Current status', value: <Badge soft tone="neutral">{current.status}</Badge> },
                  ]}
                />
              </Card>

              <Card>
                <CardHeader label="Update" title="Edit this open case" description="Only active-state fields can be changed here. Resolving or closing a case is not performed from this studio." />
                <div className="form-grid">
                  <div className="field-pair">
                    <Field label="Priority" htmlFor="rv-priority">
                      <SelectInput id="rv-priority" value={String(edit.priority)} onChange={(event) => patchEdit({ priority: Number(event.target.value) })}>
                        {PRIORITY_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </SelectInput>
                    </Field>
                    <Field label="Status" htmlFor="rv-status">
                      <SelectInput id="rv-status" value={String(edit.statusCode)} onChange={(event) => patchEdit({ statusCode: Number(event.target.value) })}>
                        {REVIEW_STATUS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </SelectInput>
                    </Field>
                  </div>
                  <Field label="Review note" htmlFor="rv-note" hint="Saved to the case as an annotation.">
                    <TextArea id="rv-note" rows={4} placeholder="Add context for the next person…" value={edit.note} onChange={(event) => patchEdit({ note: event.target.value })} />
                  </Field>
                  {saveError ? <InlineNote tone="danger">{saveError}</InlineNote> : null}
                  <div className="draft-actions">
                    <Button variant="subtle" disabled={!dirty} onClick={() => setEdits((prev) => { const next = { ...prev }; delete next[current.id]; return next })}>
                      Reset
                    </Button>
                    <Button variant="primary" disabled={!dirty} onClick={() => setConfirmOpen(true)}>
                      Save review
                    </Button>
                  </div>
                </div>
              </Card>

              <div className="split-2">
                <Card>
                  <CardHeader label="Notes" title={<><FileText size={14} /> Case notes</>} />
                  {notesForCase(snapshot, current.id).length === 0 ? (
                    <p className="muted-note">No notes on this case.</p>
                  ) : (
                    <ul className="audit-list">
                      {notesForCase(snapshot, current.id).map((note) => (
                        <li key={note.id}>
                          <span className="audit-list__title">{note.subject || note.filename || 'Note'}</span>
                          <span className="audit-list__meta">{formatDate(note.createdAt)}</span>
                          {note.body ? <p className="audit-list__body">{note.body}</p> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card>
                  <CardHeader label="Tasks" title={<><ListChecks size={14} /> Case tasks</>} />
                  {tasksForCase(snapshot, current.id).length === 0 ? (
                    <p className="muted-note">No tasks on this case.</p>
                  ) : (
                    <ul className="audit-list">
                      {tasksForCase(snapshot, current.id).map((task) => (
                        <li key={task.id}>
                          <span className="audit-list__title">{task.subject || 'Task'}</span>
                          <span className="audit-list__meta">{task.status}{task.dueAt ? ` · due ${formatDate(task.dueAt)}` : ''}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </>
          )}
        </div>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Save this review?"
        description={state.settings.mode === 'preview' ? 'Preview changes stay local; nothing is written to Dataverse.' : 'These changes are written to the live case and visible to your service team.'}
        footer={
          <>
            <Button variant="subtle" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant="primary" icon={saving ? <Spinner /> : undefined} disabled={saving || !edit.note.trim()} onClick={() => void doSave()}>
              Confirm &amp; save
            </Button>
          </>
        }
      >
        {current ? (
          <dl className="confirm__fields">
            <div><dt>Case</dt><dd>{current.number}</dd></div>
            <div><dt>Priority</dt><dd>{priorityLabel(edit.priority)}</dd></div>
            <div><dt>Status</dt><dd>{statusLabel(edit.statusCode)}</dd></div>
            <div><dt>Note</dt><dd>{edit.note.trim() ? edit.note : <span className="muted-note">No note added</span>}</dd></div>
          </dl>
        ) : null}
      </Modal>
    </div>
  )
}
