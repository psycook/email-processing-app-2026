import { useMemo, useState } from 'react'
import type { CampaignConfig, Complexity, EmailDraft, RequestClass } from '../types'
import { REQUEST_CLASSES } from '../types'
import { downloadText } from '../lib/studioEngine'
import { useApp } from '../ui/studioContext'
import {
  Card,
  CardHeader,
  SectionLabel,
  Field,
  TextInput,
  Segmented,
  Checkbox,
  Button,
  Badge,
  EmptyState,
  Spinner,
  ProgressBar,
} from '../ui/primitives'
import { InlineNote } from '../ui/Banners'
import { Modal } from '../ui/Modal'
import { AttachmentList } from '../ui/Attachments'
import { COMPLEXITY_OPTIONS, classLabel } from '../ui/constants'
import { draftToEml, emlFilename } from '../ui/eml'
import { clamp, cx } from '../ui/util'
import type { Tone } from '../ui/primitives'
import { Megaphone, Play, Pause, Square, Download, TriangleAlert, Check, X } from '../ui/icons'

const DEFAULT_CATEGORIES: RequestClass[] = ['account-servicing', 'card-support', 'payments']

function stateTone(state: EmailDraft['state']): Tone {
  switch (state) {
    case 'sent':
      return 'success'
    case 'failed':
      return 'danger'
    case 'sending':
      return 'info'
    case 'unknown':
      return 'warning'
    default:
      return 'neutral'
  }
}

export function CampaignsPage() {
  const { studio } = useApp()
  const { state, actions } = studio
  const { snapshot, settings } = state
  const maxCustomers = Math.max(1, snapshot.customers.length)

  const [customerCount, setCustomerCount] = useState(Math.min(5, maxCustomers))
  const [emailCount, setEmailCount] = useState(12)
  const [categories, setCategories] = useState<RequestClass[]>(DEFAULT_CATEGORIES)
  const [complexity, setComplexity] = useState<Complexity>('multi-intent')
  const [source, setSource] = useState<'template' | 'ai'>('template')
  const [attachment, setAttachment] = useState<'none' | 'pdf' | 'image'>('none')
  const [intervalSeconds, setIntervalSeconds] = useState(3)
  const [selectedId, setSelectedId] = useState<string>('')
  const [launchOpen, setLaunchOpen] = useState(false)
  const [generating, setGenerating] = useState(false)

  const status = state.campaignStatus
  const queue = useMemo(() => (status === 'idle' ? [] : state.drafts.filter(item => item.runId === state.campaignRunId)), [status, state.drafts, state.campaignRunId])
  const hasQueue = queue.length > 0
  const selected: EmailDraft | null = queue.find((item) => item.id === selectedId) ?? queue[0] ?? null

  const stats = useMemo(() => {
    const total = queue.length
    const sent = queue.filter((item) => item.state === 'sent').length
    const failed = queue.filter((item) => item.state === 'failed').length
    const cancelled = queue.filter((item) => item.state === 'cancelled').length
    const unknown = queue.filter((item) => item.state === 'unknown').length
    const settled = sent + failed + cancelled
    return { total, sent, failed, cancelled, unknown, settled, fraction: total ? settled / total : 0 }
  }, [queue])

  const toggleCategory = (value: RequestClass) => {
    setCategories((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    )
  }

  const config: CampaignConfig = {
    customerCount: clamp(customerCount, 1, maxCustomers),
    emailCount: clamp(emailCount, 1, 200),
    categories,
    complexity,
    intervalSeconds: clamp(intervalSeconds, 1, 120),
    source,
    attachment,
  }

  const blockReasons: string[] = []
  if (settings.mode === 'preview') blockReasons.push('Preview mode is on — launching will not send real email.')
  if (!settings.aliasSendingConfirmed) blockReasons.push('Sending alias is not confirmed in Settings.')
  if (!['ready', 'paused'].includes(status)) blockReasons.push('Only a complete, reviewed queue can launch.')
  if (queue.some(item => item.state === 'unknown')) blockReasons.push('Reconcile uncertain sends before resuming.')
  const canLaunch = blockReasons.length === 0

  const handleGenerate = async () => {
    if (categories.length === 0) return
    setGenerating(true)
    try {
      await actions.generateCampaign(config)
    } catch (error) {
      actions.notify(error instanceof Error ? error.message : 'Generation failed.', 'error')
    } finally {
      setGenerating(false)
    }
  }

  const launch = async () => {
    try {
      await actions.startCampaign()
      setLaunchOpen(false)
    } catch (error) {
      actions.notify(error instanceof Error ? error.message : 'Launch failed.', 'error')
    }
  }

  const exportQueueJson = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    downloadText(`gravity-campaign-${stamp}.json`, JSON.stringify({ config, drafts: queue }, null, 2), 'application/json')
    actions.notify('Campaign exported as JSON', 'success')
  }

  const running = status === 'running'
  const paused = status === 'paused'

  return (
    <div className="page">
      <section className="page-head">
        <div>
          <SectionLabel>Campaigns</SectionLabel>
          <h1 className="page-title">Generate a batch of test emails</h1>
          <p className="page-lede">
            Build a reviewable queue of synthetic customer emails, inspect every one, then launch the batch into the help
            mailbox at a controlled interval.
          </p>
        </div>
      </section>

      <div className="campaign-layout">
        <Card className="campaign-config">
          <CardHeader label="1 · Define batch" title="Configuration" />
          <div className="form-grid">
            <div className="field-pair">
              <Field label="Customers" htmlFor="c-count" hint={`Max ${maxCustomers}`}>
                <TextInput
                  id="c-count"
                  type="number"
                  min={1}
                  max={maxCustomers}
                  value={customerCount}
                  onChange={(event) => setCustomerCount(clamp(Number(event.target.value) || 1, 1, maxCustomers))}
                />
              </Field>
              <Field label="Total emails" htmlFor="e-count" hint="1–200">
                <TextInput
                  id="e-count"
                  type="number"
                  min={1}
                  max={200}
                  value={emailCount}
                  onChange={(event) => setEmailCount(clamp(Number(event.target.value) || 1, 1, 200))}
                />
              </Field>
            </div>

            <Field label="Request classes" hint={categories.length === 0 ? 'Select at least one class.' : `${categories.length} selected`}>
              <div className="check-grid">
                {REQUEST_CLASSES.map((item) => (
                  <Checkbox
                    key={item.value}
                    id={`cat-${item.value}`}
                    checked={categories.includes(item.value)}
                    onChange={() => toggleCategory(item.value)}
                    label={item.label}
                  />
                ))}
              </div>
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

            <div className="field-pair">
              <Field label="Generation">
                <Segmented
                  ariaLabel="Generation source"
                  size="sm"
                  value={source}
                  onChange={setSource}
                  options={[
                    { value: 'template', label: 'Template' },
                    { value: 'ai', label: 'AI' },
                  ]}
                />
              </Field>
              <Field label="Attachment">
                <Segmented
                  ariaLabel="Attachment type"
                  size="sm"
                  value={attachment}
                  onChange={setAttachment}
                  options={[
                    { value: 'none', label: 'None' },
                    { value: 'pdf', label: 'PDF' },
                    { value: 'image', label: 'Image' },
                  ]}
                />
              </Field>
            </div>

            <Field label="Send interval (seconds)" htmlFor="interval" hint="Delay between messages when launched.">
              <TextInput
                id="interval"
                type="number"
                min={1}
                max={120}
                value={intervalSeconds}
                onChange={(event) => setIntervalSeconds(clamp(Number(event.target.value) || 0, 0, 120))}
              />
            </Field>

            <Button
              variant="primary"
              block
              icon={generating || status === 'generating' ? <Spinner /> : <Megaphone size={16} />}
              disabled={categories.length === 0 || generating || status === 'generating' || running || hasQueue}
              onClick={handleGenerate}
            >
              {hasQueue ? 'Regenerate queue' : 'Generate queue'}
            </Button>
            {running ? <InlineNote tone="warning">Pause or cancel the running batch before regenerating.</InlineNote> : null}
          </div>
        </Card>

        <Card className="campaign-queue">
          <CardHeader
            label="2 · Review & launch"
            title="Queue"
            actions={
              hasQueue ? (
                <Badge tone={running ? 'info' : paused ? 'warning' : status === 'completed' ? 'success' : 'neutral'}>
                  {status}
                </Badge>
              ) : undefined
            }
          />

          {!hasQueue ? (
            <EmptyState
              icon={<Megaphone size={22} />}
              title={status === 'generating' ? 'Generating…' : 'No queue yet'}
              description={status === 'generating' ? 'Building your batch of drafts.' : 'Define a batch and generate the queue to review every draft here.'}
            />
          ) : (
            <>
              <div className="queue-progress">
                <ProgressBar value={stats.fraction} label="Campaign progress" />
                <div className="queue-progress__stats">
                  <span><strong>{stats.total}</strong> total</span>
                  <span className="t-success"><strong>{stats.sent}</strong> sent</span>
                  <span className="t-warning"><strong>{stats.unknown}</strong> unknown</span>
                  <span className="t-danger"><strong>{stats.failed}</strong> failed</span>
                  <span><strong>{stats.cancelled}</strong> cancelled</span>
                </div>
              </div>

              <div className="queue-controls">
                {running ? (
                  <Button variant="secondary" size="sm" icon={<Pause size={14} />} onClick={() => actions.pauseCampaign()}>
                    Pause
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Play size={14} />}
                    disabled={!['ready', 'paused'].includes(status)}
                    onClick={() => setLaunchOpen(true)}
                  >
                    {paused ? 'Resume' : 'Launch batch'}
                  </Button>
                )}
                <Button variant="subtle" size="sm" icon={<Square size={14} />} disabled={!running && !paused} onClick={() => actions.cancelCampaign()}>
                  Cancel
                </Button>
                <Button variant="subtle" size="sm" icon={<Download size={14} />} onClick={exportQueueJson}>
                  Export JSON
                </Button>
                <Button variant="ghost" size="sm" icon={<X size={14} />} disabled={running} onClick={() => actions.discardCampaign()}>
                  Discard
                </Button>
              </div>

              <InlineNote tone="warning">
                This queue lives only in this browser tab. Closing or reloading it loses the queue and a launched batch
                cannot be resumed. Where a send outcome is <strong>unknown</strong>, confirm it by inspecting the mailbox,
                then reconcile it below.
              </InlineNote>

              <div className="queue-split">
                <ul className="queue-list">
                  {queue.map((item, index) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={cx('queue-item', selected?.id === item.id && 'queue-item--active')}
                        onClick={() => setSelectedId(item.id)}
                      >
                        <span className="queue-item__index">{String(index + 1).padStart(2, '0')}</span>
                        <span className="queue-item__main">
                          <span className="queue-item__subject">{item.subject || '(no subject)'}</span>
                          <span className="queue-item__to">{item.to}</span>
                        </span>
                        <Badge tone={stateTone(item.state)} soft>
                          {item.state}
                        </Badge>
                      </button>
                    </li>
                  ))}
                </ul>

                <div className="queue-detail">
                  {!selected ? (
                    <EmptyState title="Select a draft" />
                  ) : (
                    <div className="draft-preview">
                      <div className="draft-meta">
                        <span><strong>From</strong> {selected.from}</span>
                        <span><strong>To</strong> {selected.to}</span>
                        <Badge soft tone="neutral">{classLabel(selected.category)}</Badge>
                        <Badge soft tone="neutral">{selected.complexity}</Badge>
                        <Badge tone={stateTone(selected.state)}>{selected.state}</Badge>
                      </div>
                      <h3 className="draft-preview__subject">{selected.subject || '(no subject)'}</h3>
                      <div className="draft-preview__body">{selected.body}</div>
                      {selected.error ? <InlineNote tone="danger">{selected.error}</InlineNote> : null}
                      <div className="draft-preview__attach">
                        <SectionLabel>Attachments</SectionLabel>
                        <AttachmentList attachments={selected.attachments} compact />
                      </div>
                      <div className="draft-preview__foot">
                        <Button
                          variant="subtle"
                          size="sm"
                          icon={<Download size={14} />}
                          onClick={() => downloadText(emlFilename(selected), draftToEml(selected), 'message/rfc822')}
                        >
                          Export .eml
                        </Button>
                        {selected.state === 'unknown' ? (
                          <span className="reconcile">
                            <span className="muted-note">Confirm in mailbox, then:</span>
                            <Button variant="secondary" size="sm" icon={<Check size={14} />} onClick={() => actions.reconcileDraft(selected.id, 'sent')}>
                              Mark sent
                            </Button>
                            <Button variant="ghost" size="sm" icon={<X size={14} />} onClick={() => actions.reconcileDraft(selected.id, 'cancelled')}>
                              Mark cancelled
                            </Button>
                          </span>
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </Card>
      </div>

      <Modal
        open={launchOpen}
        onClose={() => setLaunchOpen(false)}
        title={paused ? 'Resume this batch?' : 'Launch this batch?'}
        description="The whole reviewed queue will be dispatched."
        tone="accent"
        footer={
          <>
            <Button variant="subtle" onClick={() => setLaunchOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon={<Play size={15} />} disabled={!canLaunch} onClick={() => void launch()}>
              {paused ? 'Resume batch' : 'Launch batch'}
            </Button>
          </>
        }
      >
        <div className="confirm">
          <div className="confirm__warn">
            <TriangleAlert size={16} />
            <span>
              This sends <strong>{queue.length}</strong> synthetic emails to <strong>{settings.helpMailbox}</strong> and
              triggers the live workflow for each. Some outcomes may be reported as unknown.
            </span>
          </div>
          <dl className="confirm__fields">
            <div><dt>Recipient</dt><dd>{settings.helpMailbox}</dd></div>
            <div><dt>Emails</dt><dd>{queue.length}</dd></div>
            <div><dt>Interval</dt><dd>{state.campaignConfig?.intervalSeconds ?? config.intervalSeconds}s between sends</dd></div>
          </dl>
          <div className="confirm__attach">
            <SectionLabel>Exact reviewed messages</SectionLabel>
            <p className="muted-note">This batch contains synthetic customer details from private demo data. Confirm only after reviewing the content and attachments.</p>
            {queue.filter(item => ['draft', 'failed'].includes(item.state)).map(item => (
              <details key={item.id} className="confirm-batch-item">
                <summary>{item.from} → {item.to} · {item.subject}</summary>
                <pre className="confirm__body">{item.body}</pre>
                <p>Attachments: {item.attachments.map(attachment => attachment.name).join(', ') || 'None'}</p>
              </details>
            ))}
          </div>
          {!canLaunch ? (
            <InlineNote tone={settings.mode === 'preview' ? 'info' : 'warning'}>
              <ul className="reason-list">
                {blockReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </InlineNote>
          ) : null}
        </div>
      </Modal>
    </div>
  )
}
