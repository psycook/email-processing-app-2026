import { useState } from 'react'
import type { ThemeMode } from '../types'
import { APP_VERSION, ENVIRONMENT } from '../types'
import { useApp } from '../ui/studioContext'
import {
  Card,
  CardHeader,
  SectionLabel,
  Badge,
  Button,
  Field,
  Segmented,
  Toggle,
  Checkbox,
  TextArea,
  StatusDot,
  MetaRow,
} from '../ui/primitives'
import type { Tone } from '../ui/primitives'
import { InlineNote } from '../ui/Banners'
import { Modal } from '../ui/Modal'
import {
  Server,
  ShieldAlert,
  Sun,
  Moon,
  Monitor,
  LockKeyhole,
  Bot,
  Info,
} from '../ui/icons'


function healthTone(status: 'healthy' | 'error' | 'unavailable'): Tone {
  if (status === 'healthy') return 'success'
  if (status === 'error') return 'danger'
  return 'warning'
}

export function SettingsPage() {
  const { studio } = useApp()
  const { state, actions } = studio
  const { settings, snapshot, campaignStatus } = state

  const [confirmLive, setConfirmLive] = useState(false)

  const campaignBusy = campaignStatus === 'generating' || campaignStatus === 'running' || campaignStatus === 'paused'
  const pollValue = settings.polling ? String(settings.pollSeconds) : 'pause'

  const setPoll = (next: string) => {
    if (next === 'pause') actions.setSettings({ polling: false })
    else actions.setSettings({ polling: true, pollSeconds: Number(next) })
  }

  const requestMode = (next: 'live' | 'preview') => {
    if (next === settings.mode) return
    if (campaignBusy) return
    if (next === 'live') {
      setConfirmLive(true)
      return
    }
    actions.setSettings({ mode: 'preview' })
    actions.notify('Switched to preview mode', 'info')
  }

  const confirmGoLive = () => {
    actions.setSettings({ mode: 'live' })
    setConfirmLive(false)
    actions.notify('Live mode enabled', 'info')
  }

  return (
    <div className="page">
      <section className="page-head">
        <div>
          <SectionLabel>Settings</SectionLabel>
          <h1 className="page-title">Environment &amp; studio configuration</h1>
          <p className="page-lede">Connection, data mode, appearance and sending controls for this studio.</p>
        </div>
        <Badge soft tone={settings.mode === 'live' ? 'danger' : 'lavender'}>
          {settings.mode === 'live' ? 'LIVE' : 'PREVIEW'}
        </Badge>
      </section>

      <div className="settings-grid">
        <Card className="settings-span connection-card">
          <CardHeader label="Environment" title={<><Server size={15} /> Connection</>} description="Read-only environment binding for this app." />
          <MetaRow
            items={[
              { label: 'Dataverse URL', value: <span className="mono">{ENVIRONMENT.url}</span> },
              { label: 'Environment ID', value: <span className="mono">{ENVIRONMENT.id}</span> },
              { label: 'Domain', value: <span className="mono">{ENVIRONMENT.domain}</span> },
              { label: 'Snapshot taken', value: snapshot.fetchedAt ? new Date(snapshot.fetchedAt).toLocaleString() : '—' },
            ]}
          />
          <div className="health-list" role="list" aria-label="Environment connections">
            {snapshot.health.length === 0 ? (
              <p className="muted-note">No source health reported.</p>
            ) : (
              snapshot.health.map((source) => (
                <div className="health-list__row" role="listitem" key={source.source}>
                  <span className="health-list__name">
                    <StatusDot tone={healthTone(source.status)} />
                    <span className="health-list__label">{source.source === `Inbox: ${settings.helpMailbox}` ? 'Help Inbox' : source.source}</span>
                  </span>
                  <span className="health-list__detail">
                    {source.detail || source.status}
                    {typeof source.count === 'number' ? ` · ${source.count}` : ''}
                  </span>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card>
          <CardHeader label="Data mode" title="Live or preview" description="Preview uses a local adapter and never sends. Live reads your environment and can send when explicitly triggered." />
          <Segmented
            ariaLabel="Data mode"
            value={settings.mode}
            onChange={(next) => requestMode(next)}
            options={[
              { value: 'preview', label: 'Preview' },
              { value: 'live', label: 'Live' },
            ]}
          />
          {campaignBusy ? (
            <InlineNote tone="warning">A campaign is in progress. Finish, pause-and-cancel, or discard it before changing data mode.</InlineNote>
          ) : null}
          <p className="muted-note">Switching mode is handled by the host, which clears the working snapshot and drafts.</p>

          <div className="setting-row">
            <div className="setting-row__text">
              <p className="setting-row__title">Auto refresh</p>
              <p className="setting-row__desc">Poll the environment on an interval.</p>
            </div>
            <Toggle
              label="Auto refresh"
              checked={settings.polling}
              onChange={(next) => actions.setSettings({ polling: next })}
            />
          </div>
          <Field label="Poll interval" htmlFor="poll-interval">
            <Segmented
              ariaLabel="Poll interval"
              size="sm"
              value={pollValue}
              onChange={setPoll}
              options={[
                { value: '10', label: '10s' },
                { value: '20', label: '20s' },
                { value: '30', label: '30s' },
                { value: '60', label: '60s' },
                { value: 'pause', label: 'Pause' },
              ]}
            />
          </Field>
        </Card>

        <Card>
          <CardHeader label="Appearance" title="Theme" description="Applies instantly across the studio." />
          <Segmented<ThemeMode>
            ariaLabel="Theme"
            value={settings.theme}
            onChange={(next) => actions.setSettings({ theme: next })}
            options={[
              { value: 'light', label: 'Light', icon: <Sun size={14} /> },
              { value: 'dark', label: 'Dark', icon: <Moon size={14} /> },
              { value: 'system', label: 'System', icon: <Monitor size={14} /> },
            ]}
          />
        </Card>

        <Card>
          <CardHeader label="Sending" title={<><LockKeyhole size={15} /> Mailbox roles &amp; aliases</>} description="Help is the only inbound monitor. Demo customer provides sender aliases; its Inbox is not polled." />
          <MetaRow
            items={[
              { label: 'Inbound monitor', value: <span className="mono">{settings.helpMailbox}</span> },
              { label: 'Outbound alias pool', value: <span className="mono">{settings.senderMailbox}</span> },
            ]}
          />
          <div className="alias-confirm">
            <Checkbox
              id="alias-confirmed"
              checked={settings.aliasSendingConfirmed}
              onChange={(next) => actions.setSettings({ aliasSendingConfirmed: next })}
              label="I have verified the received From address matches a customer alias"
            />
            <p className="muted-note">
              This confirmation only affects whether this studio enables the send button. The tenant
              <span className="mono"> SendFromAliasEnabled</span> setting is not changed by this app.
            </p>
            <p className="muted-note">
              An Exchange administrator must enable sending from aliases for the demo tenant. Even then,
              shared-mailbox alias support varies by client and connector. Inspect the email address in
              the received message&apos;s From header, not just the &quot;Demo Customer&quot; display name.
              Do not confirm this checkbox if that address is the shared mailbox&apos;s primary address.
            </p>
          </div>
        </Card>

        <Card className="settings-span">
          <CardHeader
            label="Advanced"
            title={<><Bot size={15} /> Generation definition</>}
            description="The built-in AI author uses an isolated, tool-free agent definition through the existing agent connector."
          />
          <InlineNote tone="warning">
            This defines generation of synthetic sample content only. It is not a classifier, router, or any production
            decision logic, and it does not change how real email is processed. AI generation requires Live mode and may incur
            model charges. Availability depends on the connector and environment policy; failures are shown, never replaced with a template labelled AI.
          </InlineNote>
          <Field label="Advanced definition JSON" htmlFor="gen-def" hint="Normally leave blank. Only the strict, independent generation-only schema is accepted. No credentials, tools or actions.">
            <TextArea
              id="gen-def"
              rows={5}
              placeholder="Leave blank to use the built-in generation-only definition."
              value={settings.generationDefinition}
              onChange={(event) => actions.setSettings({ generationDefinition: event.target.value })}
            />
          </Field>
        </Card>

        <Card className="settings-span">
          <CardHeader label="About" title={<><Info size={15} /> This build</>} />
          <MetaRow
            items={[
              { label: 'Version', value: <Badge soft tone="neutral">v{APP_VERSION}</Badge> },
              { label: 'Environment', value: <Badge soft tone={settings.mode === 'live' ? 'danger' : 'lavender'}>{settings.mode === 'live' ? 'LIVE' : 'PREVIEW'}</Badge> },
              { label: 'Current mailbox window from', value: snapshot.windowStart ? new Date(snapshot.windowStart).toLocaleString() : '—' },
            ]}
          />
          <InlineNote tone="info">
            <span className="setting-note-head"><ShieldAlert size={14} /> Publishing</span>
            Publishing this app is managed outside the studio and may be restricted in this environment. Nothing here
            publishes or deploys.
          </InlineNote>
        </Card>
      </div>

      <Modal
        open={confirmLive}
        onClose={() => setConfirmLive(false)}
        title="Switch to live mode?"
        description="Live mode reads your real environment. Sending remains a separate, explicit action."
        footer={
          <>
            <Button variant="subtle" onClick={() => setConfirmLive(false)}>Stay in preview</Button>
            <Button variant="primary" onClick={confirmGoLive}>Enable live mode</Button>
          </>
        }
      >
        <InlineNote tone="warning">
          In live mode the studio works against production data. Draft sending is still gated by the alias confirmation
          and a per-send review step — nothing is sent automatically.
        </InlineNote>
      </Modal>
    </div>
  )
}
