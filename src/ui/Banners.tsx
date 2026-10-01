import type { SourceHealth, DataMode } from '../types'
import type { ReactNode } from 'react'
import { cx } from './util'
import { TriangleAlert, CircleAlert, Info } from './icons'

export function SystemBanners({
  error,
  health,
  truncated,
  mode,
}: {
  error?: string
  health: SourceHealth[]
  truncated: string[]
  mode: DataMode
}) {
  const degraded = health.filter((item) => item.status !== 'healthy')
  const hasTruncation = truncated.length > 0
  if (mode !== 'preview' && !error && degraded.length === 0 && !hasTruncation) return null

  return (
    <div className="banner-stack">
      {mode === 'preview' ? <div className="banner banner--info"><Info size={16} aria-hidden="true" /><span><strong>Synthetic preview</strong> — local demonstration data. No live reads or sends.</span></div> : null}
      {error ? (
        <div className="banner banner--danger" role="alert">
          <span className="banner__icon" aria-hidden="true">
            <CircleAlert size={18} />
          </span>
          <div className="banner__body">
            <p className="banner__title">We hit an error loading live data</p>
            <p className="banner__detail">{error}</p>
          </div>
        </div>
      ) : null}

      {degraded.length > 0 ? (
        <div className="banner banner--warning" role="status">
          <span className="banner__icon" aria-hidden="true">
            <TriangleAlert size={18} />
          </span>
          <div className="banner__body">
            <p className="banner__title">
              {degraded.length} data {degraded.length === 1 ? 'source is' : 'sources are'} degraded
            </p>
            <ul className="banner__list">
              {degraded.map((item) => (
                <li key={item.source}>
                  <strong>{item.source}</strong> — {item.status}: {item.detail}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {hasTruncation ? (
        <div className="banner banner--info" role="status">
          <span className="banner__icon" aria-hidden="true">
            <Info size={18} />
          </span>
          <div className="banner__body">
            <p className="banner__title">Some results were truncated{mode === 'preview' ? ' (preview sample)' : ''}</p>
            <p className="banner__detail">Showing a capped window for: {truncated.join(', ')}.</p>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function InlineNote({
  tone = 'info',
  children,
  className,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'accent'
  children: ReactNode
  className?: string
}) {
  const Icon = tone === 'danger' ? CircleAlert : tone === 'warning' ? TriangleAlert : Info
  return (
    <div className={cx('inline-note', `inline-note--${tone}`, className)}>
      <span className="inline-note__icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="inline-note__body">{children}</div>
    </div>
  )
}
