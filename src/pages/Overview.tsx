import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { estimateCosts, formatMoney, formatDate } from '../lib/studioEngine'
import { useApp } from '../ui/studioContext'
import { Card, CardHeader, SectionLabel, Badge, StatusDot, Button, EmptyState } from '../ui/primitives'
import { CaseCategoryCard } from '../ui/CaseCategoryCard'
import { Pipeline } from '../ui/Pipeline'
import type { StageCount } from '../ui/Pipeline'
import { ProcessCanvas } from '../ui/ProcessCanvas'
import { INVENTORIED_PROCESS, legacyProcessEnabled } from '../process/definition'
import {
  openCases,
  unreadMessages,
  messagesForMailbox,
  sourceHealthy,
  sortByReceived,
  caseCategoryMix,
  totalBalance,
} from '../ui/selectors'
import { priorityLabel, priorityTone } from '../ui/constants'
import { relativeTime } from '../ui/util'
import {
  Mail,
  ClipboardCheck,
  Users,
  PiggyBank,
  ArrowUpRight,
  ArrowRight,
  Paperclip,
  Activity,
} from '../ui/icons'

function Kpi({
  icon,
  label,
  value,
  sub,
  onClick,
  tone = 'accent',
}: {
  icon: ReactNode
  label: string
  value: ReactNode
  sub: ReactNode
  onClick: () => void
  tone?: 'accent' | 'lavender' | 'warning' | 'info'
}) {
  return (
    <button type="button" className="card kpi" onClick={onClick}>
      <span className={`kpi__icon kpi__icon--${tone}`} aria-hidden="true">
        {icon}
      </span>
      <span className="kpi__value">{value}</span>
      <span className="kpi__label">{label}</span>
      <span className="kpi__sub">{sub}</span>
      <span className="kpi__go" aria-hidden="true">
        <ArrowUpRight size={15} />
      </span>
    </button>
  )
}

export function OverviewPage() {
  const { studio } = useApp()
  const { state, actions } = studio
  const { snapshot } = state
  const mailReady = sourceHealthy(snapshot, `Inbox: ${state.settings.helpMailbox}`)
  const casesReady = sourceHealthy(snapshot, 'Cases')
  const customersReady = sourceHealthy(snapshot, 'Contacts')

  const intake = useMemo(() => messagesForMailbox(snapshot, state.settings.helpMailbox), [snapshot, state.settings.helpMailbox])
  const unread = useMemo(() => unreadMessages(intake), [intake])
  const open = useMemo(() => openCases(snapshot), [snapshot])
  const recent = useMemo(() => sortByReceived(snapshot.messages).slice(0, 6), [snapshot.messages])
  const mix = useMemo(() => caseCategoryMix(snapshot.cases), [snapshot.cases])
  const costs = useMemo(() => estimateCosts(state.settings.costs), [state.settings.costs])
  const balance = useMemo(() => totalBalance(snapshot.holdings), [snapshot.holdings])

  const timeline = useMemo(() => {
    const buckets = new Map<string, number>()
    for (const message of snapshot.messages) {
      const date = new Date(message.receivedAt)
      if (Number.isNaN(date.getTime())) continue
      const key = date.toISOString().slice(0, 10)
      buckets.set(key, (buckets.get(key) ?? 0) + 1)
    }
    const entries = Array.from(buckets.entries()).sort((a, b) => a[0].localeCompare(b[0])).slice(-10)
    const max = entries.reduce((peak, [, count]) => Math.max(peak, count), 0) || 1
    return { entries, max }
  }, [snapshot.messages])

  const counts: Record<string, StageCount | undefined> = {
    mailbox: { value: mailReady ? intake.length : '—', label: 'help inbox window' },
    review: { value: casesReady ? open.length : '—', label: 'open cases' },
  }

  const topOpen = open.slice(0, 5)

  return (
    <div className="page">
      <section className="hero">
        <div className="hero__text">
          <SectionLabel>Gravity Bank · Process automation</SectionLabel>
          <h1 className="hero__title">Every email. A clearer outcome.</h1>
          <p className="hero__lede">
            A live window onto how inbound customer email is received, matched, classified and routed — grounded only
            in what the connectors actually report.
          </p>
        </div>
        <div className="hero__actions">
          <Button variant="primary" icon={<Mail size={16} />} onClick={() => actions.navigate('mailbox')}>
            Open mailboxes
          </Button>
          <Button variant="secondary" icon={<Activity size={16} />} onClick={() => actions.navigate('process')}>
            View process
          </Button>
        </div>
      </section>

      <div className="kpi-grid">
        <Kpi
          icon={<Mail size={18} />}
          label="Unread help email"
          value={mailReady ? unread.length : '—'}
          sub={mailReady ? `${intake.length} help messages since ${formatDate(snapshot.windowStart)}` : 'Help mailbox data unavailable or stale'}
          onClick={() => actions.navigate('mailbox')}
        />
        <Kpi
          icon={<ClipboardCheck size={18} />}
          label="Open cases"
          value={casesReady ? open.length : '—'}
          sub={casesReady ? `${snapshot.cases.length} cases in scope` : 'Case data unavailable or stale'}
          tone="warning"
          onClick={() => actions.navigate('review')}
        />
        <Kpi
          icon={<Users size={18} />}
          label="Customer portfolio"
          value={customersReady ? snapshot.customers.length : '—'}
          sub={`${snapshot.holdings.length} holdings · ${snapshot.products.length} products`}
          tone="lavender"
          onClick={() => actions.navigate('customers')}
        />
        <Kpi
          icon={<PiggyBank size={18} />}
          label="Modelled monthly saving"
          value={formatMoney(costs.monthlySavings)}
          sub={`Scenario · ${Math.round(state.settings.costs.automationRate * 100)}% automation`}
          tone="info"
          onClick={() => actions.navigate('value')}
        />
      </div>

      <Card className="pipeline-card">
        <CardHeader
          label="Process map · read-only"
          title="Shared mailbox to customer response."
          description="A simple business view of the process: mailbox, classifier, agent, case handling, outcome and email response. The stage list keeps the underlying configuration detail available without crowding the dashboard."
          actions={
            <Button variant="ghost" size="sm" iconRight={<ArrowRight size={14} />} onClick={() => actions.navigate('process')}>
              Open Process Studio
            </Button>
          }
        />
        {legacyProcessEnabled() ? <Pipeline counts={counts} refreshing={state.refreshing} /> : <ProcessCanvas definition={INVENTORIED_PROCESS} compact />}
      </Card>

      <div className="split-2">
        <Card className="recent-mail-card">
          <CardHeader
            label="Recent communications"
            title="Latest inbound email"
            actions={
              <Button variant="ghost" size="sm" iconRight={<ArrowRight size={14} />} onClick={() => actions.navigate('mailbox')}>
                All messages
              </Button>
            }
          />
          {recent.length === 0 ? (
            <EmptyState icon={<Mail size={20} />} title="No messages in this window" description="Widen the window or refresh to pull more." />
          ) : (
            <ul className="comm-list">
              {recent.map((message) => (
                <li key={message.id}>
                  <button type="button" className="comm-row" onClick={() => actions.navigate('mailbox')}>
                    <StatusDot tone={message.isRead ? 'neutral' : 'accent'} />
                    <span className="comm-row__main">
                      <span className="comm-row__from" title={message.from}>{message.from}</span>
                      <span className="comm-row__subject" title={message.subject || '(no subject)'}>{message.subject || '(no subject)'}</span>
                    </span>
                    <span className="comm-row__meta">
                      {message.hasAttachments ? <Paperclip size={13} aria-label="Has attachments" /> : null}
                      <time dateTime={message.receivedAt} title={formatDate(message.receivedAt)}>{relativeTime(message.receivedAt)}</time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="timeline">
            <SectionLabel>Messages per day (observed)</SectionLabel>
            {timeline.entries.length === 0 ? (
              <p className="muted-note">No dated messages to chart.</p>
            ) : (
              <div className="timeline__bars" role="img" aria-label="Messages received per day">
                {timeline.entries.map(([day, count]) => (
                  <span className="timeline__bar" key={day} title={`${day}: ${count}`}>
                    <span className="timeline__fill" style={{ height: `${(count / timeline.max) * 100}%` }} />
                    <span className="timeline__tick">{day.slice(5)}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </Card>

        <CaseCategoryCard categories={mix} />
      </div>

      <div className="split-2">
        <Card>
          <CardHeader
            label="Open human review"
            title="Cases awaiting a person"
            actions={
              <Button variant="ghost" size="sm" iconRight={<ArrowRight size={14} />} onClick={() => actions.navigate('review')}>
                Review queue
              </Button>
            }
          />
          {topOpen.length === 0 ? (
            <EmptyState icon={<ClipboardCheck size={20} />} title="Nothing open" description="No open cases in the current snapshot." />
          ) : (
            <ul className="mini-case-list">
              {topOpen.map((item) => (
                <li key={item.id}>
                  <button type="button" className="mini-case" onClick={() => actions.navigate('review')}>
                    <span className="mini-case__main">
                      <span className="mini-case__title">{item.title || item.number}</span>
                      <span className="mini-case__meta">
                        {item.number} · {item.status}
                      </span>
                    </span>
                    <Badge tone={priorityTone(item.priority)} soft>
                      {priorityLabel(item.priority)}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="context-card">
          <CardHeader label="Context" title="Customer & product footprint" />
          <div className="context-grid">
            <div className="context-stat">
              <span className="context-stat__value">{snapshot.customers.length}</span>
              <span className="context-stat__label">Customers</span>
            </div>
            <div className="context-stat">
              <span className="context-stat__value">{snapshot.products.length}</span>
              <span className="context-stat__label">Products</span>
            </div>
            <div className="context-stat">
              <span className="context-stat__value">{snapshot.holdings.length}</span>
              <span className="context-stat__label">Holdings</span>
            </div>
            <div className="context-stat">
              <span className="context-stat__value">{formatMoney(balance)}</span>
              <span className="context-stat__label">Linked balances</span>
            </div>
          </div>
          <div className="value-teaser">
            <div>
              <SectionLabel>Modelled annual saving</SectionLabel>
              <p className="value-teaser__figure">{formatMoney(costs.annualSavings)}</p>
              <p className="muted-note">
                {costs.hoursSaved.toLocaleString()} hours saved per month at the current scenario. Estimate, not a measured result.
              </p>
            </div>
            <Button variant="secondary" size="sm" iconRight={<ArrowRight size={14} />} onClick={() => actions.navigate('value')}>
              Model it
            </Button>
          </div>
        </Card>
      </div>
    </div>
  )
}
