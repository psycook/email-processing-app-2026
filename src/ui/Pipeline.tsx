import { PIPELINE_STAGES } from './constants'
import { cx } from './util'
import { Badge } from './primitives'
import { Inbox, UserSearch, Tags, Route, Zap, UserCheck, ChevronRight } from './icons'

const STAGE_ICONS: Record<string, typeof Inbox> = {
  mailbox: Inbox,
  identify: UserSearch,
  classify: Tags,
  route: Route,
  act: Zap,
  review: UserCheck,
}

export interface StageCount {
  value: number | string
  label: string
}

export function Pipeline({
  activeId,
  counts,
  onSelect,
  refreshing,
}: {
  activeId?: string
  counts?: Record<string, StageCount | undefined>
  onSelect?: (id: string) => void
  refreshing?: boolean
}) {
  return (
    <div className={cx('pipeline', refreshing && 'pipeline--refreshing')} role="list" aria-label="Process pipeline">
      {PIPELINE_STAGES.map((stage, index) => {
        const Icon = STAGE_ICONS[stage.id]
        const count = counts?.[stage.id]
        const active = activeId === stage.id
        const inner = (
          <>
            <span className="stage__top">
              <span className="stage__icon" aria-hidden="true">
                <Icon size={16} />
              </span>
              <span className="stage__index">{String(index + 1).padStart(2, '0')}</span>
            </span>
            <span className="stage__label">{stage.label}</span>
            {count ? (
              <span className="stage__metric">
                <span className="stage__metric-value">{count.value}</span>
                <span className="stage__metric-label">{count.label}</span>
              </span>
            ) : (
              <span className="stage__config">
                <Badge tone="lavender" soft>
                  Config
                </Badge>
                <span className="stage__config-note">not instrumented</span>
              </span>
            )}
          </>
        )
        return (
          <div className="pipeline__cell" role="listitem" key={stage.id}>
            {onSelect ? (
              <button
                type="button"
                className={cx('stage', active && 'stage--active', 'stage--clickable')}
                onClick={() => onSelect(stage.id)}
                aria-pressed={active}
              >
                {inner}
              </button>
            ) : (
              <div className={cx('stage', active && 'stage--active')}>{inner}</div>
            )}
            {index < PIPELINE_STAGES.length - 1 ? (
              <span className="pipeline__arrow" aria-hidden="true">
                <ChevronRight size={16} />
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
