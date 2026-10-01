import type { StudioState } from '../types'
import { cx } from './util'
import { CircleCheck, CircleAlert, Info } from './icons'

export function ToastRegion({ toast }: { toast?: StudioState['toast'] }) {
  const tone = toast?.kind ?? 'info'
  const Icon = tone === 'success' ? CircleCheck : tone === 'error' ? CircleAlert : Info
  return (
    <div className="toast-region" aria-live="polite" aria-atomic="true">
      {toast ? (
        <div className={cx('toast', `toast--${tone}`)} role={tone === 'error' ? 'alert' : 'status'}>
          <span className="toast__icon" aria-hidden="true">
            <Icon size={18} />
          </span>
          <span className="toast__message">{toast.message}</span>
        </div>
      ) : null}
    </div>
  )
}
