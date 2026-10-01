import { useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { Complexity, EmailDraft, RequestClass } from '../types'
import { REQUEST_CLASSES } from '../types'
import {
  createDocumentAttachment,
  fileToAttachment,
  downloadText,
  validateDraft,
} from '../lib/studioEngine'
import { useApp } from '../ui/studioContext'
import {
  Card,
  CardHeader,
  SectionLabel,
  Field,
  SelectInput,
  TextInput,
  TextArea,
  Segmented,
  Button,
  Badge,
  EmptyState,
  Spinner,
} from '../ui/primitives'
import { InlineNote } from '../ui/Banners'
import { Modal } from '../ui/Modal'
import { AttachmentList } from '../ui/Attachments'
import { EvaluationResults } from '../ui/EvaluationResults'
import { holdingDisplayName } from '../lib/holdingLabels'
import { sortedCustomers, sortedHoldings } from '../lib/customerOptions'
import { holdingsForCustomer } from '../ui/selectors'
import { COMPLEXITY_OPTIONS, classLabel } from '../ui/constants'
import { draftToEml, emlFilename } from '../ui/eml'
import { FlaskConical, FileText, ImageIcon, Send, Plus, Download, Sparkle, TriangleAlert } from '../ui/icons'

export function EvaluationPage() {
  const { studio, ui } = useApp()
  const { state, actions } = studio
  const { snapshot, settings } = state
  const customers = useMemo(() => sortedCustomers(snapshot.customers), [snapshot.customers])

  const [category, setCategory] = useState<RequestClass>('account-servicing')
  const [complexity, setComplexity] = useState<Complexity>('simple')
  const [source, setSource] = useState<'template' | 'ai'>('template')
  const [draft, setDraft] = useState<EmailDraft | null>(() => state.drafts.filter(item => item.runId.startsWith('single-')).at(-1) ?? null)
  const draftRef = useRef(draft)
  const [creating, setCreating] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [sending, setSending] = useState(false)
  const [createError, setCreateError] = useState<string | undefined>(undefined)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const selectedCustomerId = ui.selectedCustomerId ?? customers[0]?.id
  const customer = customers.find((item) => item.id === selectedCustomerId)
  const holdings = useMemo(() => sortedHoldings(customer ? holdingsForCustomer(snapshot, customer.id) : []), [snapshot, customer])
  const selectedHoldingId =
    ui.selectedHoldingId && holdings.some((item) => item.id === ui.selectedHoldingId) ? ui.selectedHoldingId : ''
  const holding = holdings.find((item) => item.id === selectedHoldingId)

  const blockReasons: string[] = []
  if (settings.mode === 'preview') blockReasons.push('Preview mode is on — no email is actually sent.')
  if (!settings.aliasSendingConfirmed) blockReasons.push('Sending alias is not confirmed in Settings.')
  const alreadySent = draft?.state === 'sent'
  if (alreadySent) blockReasons.push('This draft has already been sent.')
  if (draft?.state === 'unknown') blockReasons.push('The submission outcome is uncertain. Inspect the mailbox; this draft is locked against duplicate sends.')
  const canSend = blockReasons.length === 0 && !!draft

  const patchDraft = (patch: Partial<EmailDraft> | ((current: EmailDraft) => Partial<EmailDraft>), markManual = false) => {
    const current = draftRef.current
    if (!current || !['draft', 'failed'].includes(current.state)) return
    const next: EmailDraft = { ...current, ...(typeof patch === 'function' ? patch(current) : patch), ...(markManual ? { source: 'manual' } : {}) }
    if (next.attachments !== current.attachments) validateDraft(next)
    draftRef.current = next
    actions.updateDraft(next)
    setDraft(next)
  }

  const handleCreate = async () => {
    if (!customer) return
    setCreating(true)
    setCreateError(undefined)
    try {
      const result = await actions.createDraft(
        { customer, holding, category, complexity, index: 0 },
        source,
      )
      draftRef.current = result
      setDraft(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Draft generation failed.'
      setCreateError(message)
      actions.notify(message, 'error')
    } finally {
      setCreating(false)
    }
  }

  const addGenerated = async (kind: 'pdf' | 'image') => {
    const current = draftRef.current
    const draftCustomer = customers.find(item => item.id === current?.customerId)
    const draftHolding = snapshot.holdings.find(item => item.id === current?.holdingId)
    if (!draftCustomer || !current) return
    setAttaching(true)
    try {
      const attachment = await createDocumentAttachment(kind, draftCustomer, draftHolding)
      if (draftRef.current?.id === current.id) patchDraft(latest => ({ attachments: [...latest.attachments, attachment] }))
    } catch (error) {
      actions.notify(error instanceof Error ? error.message : 'Could not generate document.', 'error')
    } finally {
      setAttaching(false)
    }
  }

  const onUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0 || !draft) return
    setAttaching(true)
    try {
      const added = await Promise.all(files.map((file) => fileToAttachment(file)))
      patchDraft(latest => ({ attachments: [...latest.attachments, ...added] }))
    } catch (error) {
      actions.notify(error instanceof Error ? error.message : 'Could not read file.', 'error')
    } finally {
      setAttaching(false)
    }
  }

  const removeAttachment = (id: string) => {
    if (!draft) return
    patchDraft({ attachments: draft.attachments.filter((item) => item.id !== id) })
  }

  const exportEml = () => {
    if (!draft) return
    downloadText(emlFilename(draft), draftToEml(draft), 'message/rfc822')
    actions.notify('Draft exported as .eml', 'success')
  }

  const doSend = async () => {
    if (!draft || !canSend) return
    setSending(true)
    try {
      await actions.sendDraft(draft)
      const sent: EmailDraft = { ...draft, state: 'sent', sentAt: new Date().toISOString() }
      draftRef.current = sent
      setDraft(sent)
      setConfirmOpen(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Send failed.'
      const failed: EmailDraft = { ...draft, state: message.startsWith('SendEmailV2 outcome is unknown:') ? 'unknown' : 'failed', error: message }
      draftRef.current = failed
      setDraft(failed)
      actions.notify(message, 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="page">
      <section className="page-head">
        <div>
          <SectionLabel>Evaluation suite</SectionLabel>
          <h1 className="page-title">Compose a single test email</h1>
          <p className="page-lede">
            Build one realistic customer email from synthetic data, attach documents, review it exactly as it will be
            sent, then dispatch it to the help mailbox to exercise the live workflow.
          </p>
        </div>
      </section>

      <div className="eval-layout">
        <Card className="eval-config">
          <CardHeader label="1 · Configure" title="Scenario" />
          {customers.length === 0 ? (
            <EmptyState icon={<FlaskConical size={20} />} title="Waiting for customers" description="Customer data has not loaded yet. Refresh if this persists." />
          ) : (
            <div className="form-grid">
              <Field label="Customer" htmlFor="eval-customer">
                <SelectInput
                  id="eval-customer"
                  value={selectedCustomerId ?? ''}
                  onChange={(event) => ui.selectCustomer(event.target.value)}
                >
                  {customers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {item.email}
                    </option>
                  ))}
                </SelectInput>
              </Field>

              <Field label="Linked holding (optional)" htmlFor="eval-holding" hint={holdings.length === 0 ? 'This customer has no holdings in scope.' : undefined}>
                <SelectInput
                  id="eval-holding"
                  value={selectedHoldingId}
                  disabled={holdings.length === 0}
                  onChange={(event) => ui.selectCustomer(customer!.id, event.target.value || undefined)}
                >
                  <option value="">No specific holding</option>
                  {holdings.map((item) => (
                    <option key={item.id} value={item.id}>
                      {holdingDisplayName(item)}
                    </option>
                  ))}
                </SelectInput>
              </Field>

              <Field label="Request class" htmlFor="eval-class">
                <SelectInput id="eval-class" value={category} onChange={(event) => setCategory(event.target.value as RequestClass)}>
                  {REQUEST_CLASSES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </SelectInput>
              </Field>

              <Field label="Complexity">
                <Segmented
                  ariaLabel="Complexity"
                  size="sm"
                  value={complexity}
                  onChange={setComplexity}
                  options={COMPLEXITY_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
                />
              </Field>

              <Field label="Generation" hint={source === 'ai' ? 'AI writes a fuller customer story in several paragraphs, tailored to this scenario.' : 'Template uses a deterministic scenario library.'}>
                <Segmented
                  ariaLabel="Generation source"
                  size="sm"
                  value={source}
                  onChange={setSource}
                  options={[
                    { value: 'template', label: 'Template', icon: <FileText size={14} /> },
                    { value: 'ai', label: 'AI', icon: <Sparkle size={14} /> },
                  ]}
                />
              </Field>

              <dl className="eval-addresses" aria-label="Addresses for the next draft">
                <div>
                  <dt>From</dt>
                  <dd><strong>{customer?.name || 'Select a customer'}</strong><span>{customer?.email || 'No sender selected'}</span></dd>
                </div>
                <div>
                  <dt>To</dt>
                  <dd><strong>Gravity Bank support</strong><span>{settings.helpMailbox}</span></dd>
                </div>
              </dl>

              {createError ? <InlineNote tone="danger">{createError}</InlineNote> : null}

              <Button variant="primary" block icon={creating ? <Spinner /> : <FlaskConical size={16} />} disabled={creating || !customer} onClick={handleCreate}>
                {draft ? 'Regenerate draft' : 'Create draft'}
              </Button>
            </div>
          )}
        </Card>

        <Card className="eval-editor">
          <CardHeader
            label="2 · Review & edit"
            title="Draft email"
            actions={draft ? <Badge tone={draft.source === 'manual' ? 'warning' : 'lavender'} soft>Source: {draft.source}</Badge> : undefined}
          />
          {!draft ? (
            <EmptyState
              icon={<Send size={22} />}
              title="No draft yet"
              description="Configure a scenario on the left and create a draft to edit and send it."
            />
          ) : (
            <div className="draft-editor">
              <dl className="eval-addresses" aria-label="Draft addresses">
                <div><dt>From</dt><dd>{draft.from}</dd></div>
                <div><dt>To</dt><dd>{draft.to}</dd></div>
              </dl>
              <div className="draft-meta">
                <Badge soft tone="neutral">{classLabel(draft.category)}</Badge>
                <Badge soft tone="neutral">{draft.complexity}</Badge>
                {draft.state === 'sent' ? <Badge tone="success">Sent</Badge> : null}
                {draft.state === 'failed' ? <Badge tone="danger">Failed</Badge> : null}
                {draft.state === 'unknown' ? <Badge tone="warning">Outcome uncertain</Badge> : null}
              </div>

              <Field label="Subject" htmlFor="draft-subject">
                <TextInput
                  id="draft-subject"
                  disabled={sending || !['draft', 'failed'].includes(draft.state)}
                  value={draft.subject}
                  onChange={(event) => patchDraft({ subject: event.target.value }, true)}
                />
              </Field>

              <Field label="Body (plain text)" htmlFor="draft-body">
                <TextArea
                  id="draft-body"
                  disabled={sending || !['draft', 'failed'].includes(draft.state)}
                  rows={10}
                  value={draft.body}
                  onChange={(event) => patchDraft({ body: event.target.value }, true)}
                />
              </Field>

              <Field label="Expected outcome" htmlFor="draft-outcome" hint="What a correct automation response should achieve.">
                <TextArea
                  id="draft-outcome"
                  disabled={sending || !['draft', 'failed'].includes(draft.state)}
                  rows={2}
                  value={draft.expectedOutcome}
                  onChange={(event) => patchDraft({ expectedOutcome: event.target.value })}
                />
              </Field>

              <div className="draft-attachments">
                <div className="draft-attachments__head">
                  <SectionLabel>Attachments</SectionLabel>
                  <div className="draft-attachments__tools">
                    <Button size="sm" variant="subtle" icon={<FileText size={14} />} disabled={attaching} onClick={() => void addGenerated('pdf')}>
                      Branded PDF
                    </Button>
                    <Button size="sm" variant="subtle" icon={<ImageIcon size={14} />} disabled={attaching} onClick={() => void addGenerated('image')}>
                      Branded PNG
                    </Button>
                    <Button size="sm" variant="subtle" icon={<Plus size={14} />} disabled={attaching} onClick={() => fileRef.current?.click()}>
                      Upload
                    </Button>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="application/pdf,image/*"
                      multiple
                      hidden
                      onChange={onUpload}
                    />
                  </div>
                </div>
                {attaching ? <p className="muted-note"><Spinner /> Preparing attachment…</p> : null}
                <AttachmentList attachments={draft.attachments} onRemove={removeAttachment} />
              </div>

              <div className="draft-actions">
                <Button variant="secondary" icon={<Download size={15} />} onClick={exportEml}>
                  Export .eml
                </Button>
                <Button variant="primary" icon={<Send size={15} />} disabled={!draft || alreadySent} onClick={() => setConfirmOpen(true)}>
                  Send test email
                </Button>
              </div>
              {blockReasons.length > 0 ? (
                <InlineNote tone={settings.mode === 'preview' ? 'info' : 'warning'}>
                  <strong>Sending is held:</strong>
                  <ul className="reason-list">
                    {blockReasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </InlineNote>
              ) : null}
            </div>
          )}
        </Card>
      </div>

      <EvaluationResults currentDraftId={draft?.id} />

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Send this test email?"
        description="Review the exact message. Nothing is sent until you confirm."
        tone="accent"
        size="lg"
        footer={
          <>
            <Button variant="subtle" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon={sending ? <Spinner /> : <Send size={15} />} disabled={!canSend || sending} onClick={() => void doSend()}>
              Confirm &amp; send
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="confirm">
            <div className="confirm__warn">
              <TriangleAlert size={16} />
              <span>
                This sends <strong>synthetic customer data</strong> to the help mailbox and <strong>triggers the live
                automation workflow</strong>.
              </span>
            </div>
            <dl className="confirm__fields">
              <div><dt>From</dt><dd>{draft.from}</dd></div>
              <div><dt>To</dt><dd>{draft.to}</dd></div>
              <div><dt>Subject</dt><dd>{draft.subject}</dd></div>
            </dl>
            <div className="confirm__body">{draft.body}</div>
            <div className="confirm__attach">
              <SectionLabel>Attachments ({draft.attachments.length})</SectionLabel>
              {draft.attachments.length === 0 ? (
                <p className="muted-note">None.</p>
              ) : (
                <ul>
                  {draft.attachments.map((attachment) => (
                    <li key={attachment.id}>
                      {attachment.name} {attachment.generated ? <Badge tone="lavender" soft>Synthetic</Badge> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {!canSend ? (
              <InlineNote tone={settings.mode === 'preview' ? 'info' : 'warning'}>
                <ul className="reason-list">
                  {blockReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </InlineNote>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
