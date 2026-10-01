import { useMemo, useRef, useState, useEffect, useId } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Page } from '../types'
import { downloadText, formatDate } from '../lib/studioEngine'
import { sortedCustomers } from '../lib/customerOptions'
import { useApp } from './studioContext'
import { PAGE_TITLES } from './studioContext'
import { Segmented, IconButton, Toggle } from './primitives'
import { cx } from './util'
import { relativeTime } from './util'
import {
  Search,
  Sun,
  Moon,
  Monitor,
  RefreshCw,
  Download,
  Menu,
  Users,
  ClipboardCheck,
  Mail,
  ArrowRight,
} from './icons'

interface SearchHit {
  id: string
  kind: 'customer' | 'case' | 'message'
  title: string
  subtitle: string
  go: () => void
}

export function Topbar({ page, onToggleNav }: { page: Page; onToggleNav: () => void }) {
  const { studio, ui } = useApp()
  const { state, actions } = studio
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const searchRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const hits = useMemo<SearchHit[]>(() => {
    const term = query.trim().toLowerCase()
    if (term.length < 2) return []
    const { snapshot } = state
    const results: SearchHit[] = []
    for (const customer of sortedCustomers(snapshot.customers)) {
      if (
        customer.name.toLowerCase().includes(term) ||
        customer.email.toLowerCase().includes(term) ||
        customer.customerNumber.toLowerCase().includes(term)
      ) {
        results.push({
          id: `c-${customer.id}`,
          kind: 'customer',
          title: customer.name,
          subtitle: customer.email,
          go: () => {
            ui.selectCustomer(customer.id)
            actions.navigate('customers')
          },
        })
      }
      if (results.length >= 12) break
    }
    for (const item of snapshot.cases) {
      if (item.title.toLowerCase().includes(term) || item.number.toLowerCase().includes(term)) {
        results.push({
          id: `k-${item.id}`,
          kind: 'case',
          title: item.title || item.number,
          subtitle: `Case ${item.number}`,
          go: () => actions.navigate('review'),
        })
      }
      if (results.length >= 18) break
    }
    for (const message of snapshot.messages) {
      if (message.subject.toLowerCase().includes(term) || message.from.toLowerCase().includes(term)) {
        results.push({
          id: `m-${message.id}`,
          kind: 'message',
          title: message.subject || '(no subject)',
          subtitle: message.from,
          go: () => actions.navigate('mailbox'),
        })
      }
      if (results.length >= 24) break
    }
    return results.slice(0, 7)
  }, [query, state, ui, actions])

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const runHit = (hit: SearchHit) => {
    hit.go()
    setOpen(false)
    setQuery('')
  }

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, hits.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter' && hits[activeIndex]) {
      runHit(hits[activeIndex])
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  const downloadSnapshot = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    downloadText(`gravity-snapshot-${stamp}.json`, JSON.stringify(state.snapshot, null, 2), 'application/json')
    actions.notify('Snapshot downloaded', 'success')
  }

  const hitIcon = (kind: SearchHit['kind']) =>
    kind === 'customer' ? <Users size={15} /> : kind === 'case' ? <ClipboardCheck size={15} /> : <Mail size={15} />

  return (
    <header className="topbar">
      <div className="topbar__left">
        <IconButton label="Open navigation" icon={<Menu size={18} />} className="topbar__menu" onClick={onToggleNav} />
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <span className="breadcrumb__root">Gravity Bank</span>
          <span className="breadcrumb__sep" aria-hidden="true">/</span>
          <span className="breadcrumb__current">{PAGE_TITLES[page]}</span>
        </nav>
      </div>

      <div className="topbar__search" ref={searchRef}>
        <span className="topbar__search-icon" aria-hidden="true">
          <Search size={16} />
        </span>
        <input
          type="search"
          className="topbar__search-input"
          placeholder="Search customers, cases, messages…"
          aria-label="Search"
          aria-expanded={open && hits.length > 0}
          aria-controls={listId}
          role="combobox"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
            setActiveIndex(0)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onSearchKey}
        />
        {open && query.trim().length >= 2 ? (
          <div className="search-popover" id={listId} role="listbox">
            {hits.length === 0 ? (
              <p className="search-popover__empty">No matches in the current snapshot.</p>
            ) : (
              hits.map((hit, index) => (
                <button
                  key={hit.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={cx('search-hit', index === activeIndex && 'search-hit--active')}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => runHit(hit)}
                >
                  <span className="search-hit__icon" aria-hidden="true">{hitIcon(hit.kind)}</span>
                  <span className="search-hit__text">
                    <span className="search-hit__title">{hit.title}</span>
                    <span className="search-hit__sub">{hit.subtitle}</span>
                  </span>
                  <span className="search-hit__go" aria-hidden="true"><ArrowRight size={14} /></span>
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>

      <div className="topbar__right">
        <span className="topbar__updated" title={`Last fetched ${formatDate(state.snapshot.fetchedAt)}`}>
          {state.refreshing ? 'Refreshing…' : `Updated ${relativeTime(state.snapshot.fetchedAt)}`}
        </span>
        <Segmented
          size="sm"
          ariaLabel="Theme"
          value={state.settings.theme}
          onChange={(theme) => actions.setSettings({ theme })}
          options={[
            { value: 'light', label: '', accessibleLabel: 'Light theme', icon: <Sun size={15} /> },
            { value: 'dark', label: '', accessibleLabel: 'Dark theme', icon: <Moon size={15} /> },
            { value: 'system', label: '', accessibleLabel: 'System theme', icon: <Monitor size={15} /> },
          ]}
        />
        <label className="topbar__auto">
          <Toggle
            label="Auto-refresh"
            checked={state.settings.polling}
            onChange={(polling) => actions.setSettings({ polling })}
          />
          <span className="topbar__auto-label">Auto</span>
        </label>
        <IconButton
          label="Refresh now"
          icon={<RefreshCw size={17} className={state.refreshing ? 'spin' : undefined} />}
          onClick={() => void actions.refresh()}
        />
        <IconButton label="Download snapshot (JSON)" icon={<Download size={17} />} onClick={downloadSnapshot} />
      </div>
    </header>
  )
}
