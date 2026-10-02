import { useMemo, useState } from 'react'
import type { MailItem } from '../types'
import { useApp } from '../ui/studioContext'
import { Card, SectionLabel, Badge, StatusDot, Segmented, Button, EmptyState, IconButton } from '../ui/primitives'
import { InlineNote } from '../ui/Banners'
import { messagesForMailbox, sortByReceived } from '../ui/selectors'
import { renderEmailBody, plainPreview } from '../ui/mailRender'
import { relativeTime, cx } from '../ui/util'
import { formatDate } from '../lib/studioEngine'
import { Mail, Search, Paperclip, ExternalLink, Copy, ImageIcon, Filter } from '../ui/icons'

type ReadFilter = 'all' | 'unread' | 'read'

export function CommunicationsPage() {
  const { studio } = useApp()
  const { state, actions } = studio
  const { snapshot, settings } = state

  const inbox = useMemo(() => messagesForMailbox(snapshot, settings.helpMailbox), [snapshot, settings.helpMailbox])
  const [query, setQuery] = useState('')
  const [readFilter, setReadFilter] = useState<ReadFilter>('all')
  const [attachmentsOnly, setAttachmentsOnly] = useState(false)
  const [selectedId, setSelectedId] = useState<string>('')

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    return sortByReceived(inbox).filter((message) => {
      if (readFilter === 'unread' && message.isRead) return false
      if (readFilter === 'read' && !message.isRead) return false
      if (attachmentsOnly && !message.hasAttachments) return false
      if (term) {
        const haystack = `${message.subject} ${message.from} ${message.replyTo ?? ''} ${message.to} ${message.body}`.toLowerCase()
        if (!haystack.includes(term)) return false
      }
      return true
    })
  }, [inbox, readFilter, attachmentsOnly, query])

  const active: MailItem | null = filtered.find((message) => message.id === selectedId) ?? filtered[0] ?? null
  const rendered = active ? renderEmailBody(active.body) : null

  const mailHealth = snapshot.health.find((item) => item.source === `Inbox: ${settings.helpMailbox}` && item.status !== 'healthy')
  const truncatedMail = snapshot.truncated.some((item) => /message|mail|email/i.test(item))

  const copyId = (id: string) => {
    navigator.clipboard?.writeText(id).then(
      () => actions.notify('Message id copied', 'success'),
      () => actions.notify('Could not copy to clipboard', 'error'),
    )
  }

  return (
    <div className="page">
      <section className="page-head">
        <div>
          <SectionLabel>Communications</SectionLabel>
          <h1 className="page-title">Help mailbox</h1>
          <p className="page-lede">
            Incoming communication in {settings.helpMailbox}, rendered safely. The demo.customer mailbox supplies
            outbound aliases only; its Inbox is not monitored. Scripts and remote images are stripped.
          </p>
        </div>
      </section>

      {mailHealth ? (
        <InlineNote tone="danger">
          Mail source “{mailHealth.source}” is {mailHealth.status}: {mailHealth.detail}
        </InlineNote>
      ) : null}
      {truncatedMail ? (
        <InlineNote tone="info">
          This is a capped window{state.settings.mode === 'preview' ? ' of sample data' : ''} from {formatDate(snapshot.windowStart)} to{' '}
          {formatDate(snapshot.fetchedAt)}. Older messages are not shown.
        </InlineNote>
      ) : null}

      <Card className="comms-toolbar">
        <div className="comms-toolbar__row">
          <span className="muted-note comms-toolbar__scope">Help Inbox · {settings.helpMailbox}</span>
          <div className="comms-toolbar__search">
            <span aria-hidden="true"><Search size={15} /></span>
            <input
              type="search"
              aria-label="Search messages"
              placeholder="Search subject, sender, Reply-To or body…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <div className="comms-toolbar__row">
          <Segmented
            ariaLabel="Read state"
            size="sm"
            value={readFilter}
            onChange={setReadFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'unread', label: 'Unread' },
              { value: 'read', label: 'Read' },
            ]}
          />
          <Button
            variant={attachmentsOnly ? 'primary' : 'subtle'}
            size="sm"
            icon={<Paperclip size={14} />}
            onClick={() => setAttachmentsOnly((value) => !value)}
            aria-pressed={attachmentsOnly}
          >
            Attachments
          </Button>
          <span className="comms-toolbar__count">
            <Filter size={13} /> {filtered.length} shown
          </span>
        </div>
      </Card>

      <div className="comms-layout">
        <Card className="comms-list-card">
          {filtered.length === 0 ? (
            <EmptyState icon={<Mail size={20} />} title="No messages match" description="Adjust the filters or search to see more." />
          ) : (
            <ul className="mail-list">
              {filtered.map((message) => (
                <li key={message.id}>
                  <button
                    type="button"
                    className={cx('mail-item', active?.id === message.id && 'mail-item--active')}
                    onClick={() => setSelectedId(message.id)}
                  >
                    <StatusDot tone={message.isRead ? 'neutral' : 'accent'} />
                    <span className="mail-item__body">
                      <span className="mail-item__top">
                        <span className={cx('mail-item__from', !message.isRead && 'mail-item__from--unread')}>{message.from}</span>
                        <span className="mail-item__time">{relativeTime(message.receivedAt)}</span>
                      </span>
                      <span className="mail-item__subject">{message.subject || '(no subject)'}</span>
                      <span className="mail-item__preview">{plainPreview(message.body, 90)}</span>
                      <span className="mail-item__tags">
                        <Badge soft tone="neutral">Help Inbox</Badge>
                        {message.hasAttachments ? (
                          <span className="mail-item__attach" aria-label="Has attachments"><Paperclip size={12} /></span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="comms-reader-card">
          {!active ? (
            <EmptyState icon={<Mail size={22} />} title="Select a message" description="Choose an email from the list to read it here." />
          ) : (
            <div className="reader">
              <div className="reader__head">
                <h2 className="reader__subject">{active.subject || '(no subject)'}</h2>
                <div className="reader__meta">
                  <span><strong>From</strong> {active.from}</span>
                  <span><strong>Reply-To</strong> {active.replyTo || 'Not supplied by connector'}</span>
                  <span><strong>To</strong> {active.to}</span>
                  <span><strong>Received</strong> {formatDate(active.receivedAt)}</span>
                  <Badge soft tone="lavender">Help Inbox</Badge>
                  {active.hasAttachments ? (
                    <Badge soft tone="neutral"><Paperclip size={12} /> Attachments</Badge>
                  ) : null}
                </div>
                <div className="reader__actions">
                  <a className="btn btn--subtle btn--sm" href="https://outlook.office.com/mail/" target="_blank" rel="noopener noreferrer">
                    <span className="btn__icon"><ExternalLink size={14} /></span>
                    <span className="btn__label">Open in Outlook</span>
                  </a>
                  {active.internetMessageId ? (
                    <IconButton label="Copy internet message id" icon={<Copy size={15} />} onClick={() => copyId(active.internetMessageId!)} />
                  ) : null}
                </div>
              </div>
              {rendered?.imagesStripped ? (
                <InlineNote tone="info">
                  <ImageIcon size={14} /> Remote images were hidden to prevent tracking.
                </InlineNote>
              ) : null}
              <div
                className={cx('reader__body', rendered?.isHtml ? 'reader__body--html' : 'reader__body--text')}
                dangerouslySetInnerHTML={{ __html: rendered?.html ?? '' }}
              />
              <p className="reader__foot muted-note">
                Rendered read-only. Replies and servicing actions happen in Outlook or the automation — this studio never
                sends on your behalf from here.
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
