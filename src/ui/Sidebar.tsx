import type { DataMode, Page } from '../types'
import gravityLogo from '../assets/gravity-icon.svg'
import { NAV_ITEMS } from './studioContext'
import { cx } from './util'
import {
  LayoutDashboard,
  Workflow,
  Mail,
  FlaskConical,
  Megaphone,
  Users,
  ClipboardCheck,
  TrendingUp,
  Settings,
} from './icons'

const ICONS: Record<Page, typeof LayoutDashboard> = {
  overview: LayoutDashboard,
  process: Workflow,
  mailbox: Mail,
  evaluation: FlaskConical,
  campaigns: Megaphone,
  customers: Users,
  review: ClipboardCheck,
  value: TrendingUp,
  settings: Settings,
}

export function Sidebar({
  page,
  mode,
  version,
  onNavigate,
  unreadCount,
  openCaseCount,
}: {
  page: Page
  mode: DataMode
  version: string
  onNavigate: (page: Page) => void
  unreadCount: number
  openCaseCount: number
}) {
  const badgeFor = (target: Page): number | undefined => {
    if (target === 'mailbox') return unreadCount || undefined
    if (target === 'review') return openCaseCount || undefined
    return undefined
  }

  return (
    <div className="sidebar">
      <div className="sidebar__brand">
        <img className="sidebar__logo" src={gravityLogo} alt="" width={40} height={40} />
        <div className="sidebar__brandtext">
          <span className="sidebar__name">Gravity Bank</span>
          <span className="sidebar__tagline">Your money. Your orbit.</span>
        </div>
      </div>

      <p className="sidebar__eyebrow">Email Process Studio</p>

      <nav className="sidebar__nav" aria-label="Primary">
        {NAV_ITEMS.map((item) => {
          const Icon = ICONS[item.page]
          const active = page === item.page
          const badge = badgeFor(item.page)
          return (
            <button
              key={item.page}
              type="button"
              className={cx('nav-item', active && 'nav-item--active')}
              aria-current={active ? 'page' : undefined}
              onClick={() => onNavigate(item.page)}
            >
              <span className="nav-item__icon" aria-hidden="true">
                <Icon size={18} />
              </span>
              <span className="nav-item__label">{item.label}</span>
              {badge ? <span className="nav-item__badge">{badge > 99 ? '99+' : badge}</span> : null}
            </button>
          )
        })}
      </nav>

      <div className="sidebar__footer">
        <div className={cx('mode-pill', mode === 'live' ? 'mode-pill--live' : 'mode-pill--preview')}>
          <span className="mode-pill__dot" aria-hidden="true" />
          {mode === 'live' ? 'Live data' : 'Preview data'}
        </div>
        <span className="sidebar__version">v{version}</span>
      </div>
    </div>
  )
}
