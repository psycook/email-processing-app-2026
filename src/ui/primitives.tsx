import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { cx } from './util'

export type Tone = 'neutral' | 'accent' | 'lavender' | 'success' | 'warning' | 'danger' | 'info'

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('section-label', className)}>{children}</p>
}

export function Card({
  children,
  className,
  as: Tag = 'section',
  interactive,
  ...rest
}: {
  children: ReactNode
  className?: string
  as?: 'section' | 'div' | 'article'
  interactive?: boolean
} & Omit<HTMLAttributes<HTMLElement>, 'className'>) {
  return (
    <Tag className={cx('card', interactive && 'card--interactive', className)} {...rest}>
      {children}
    </Tag>
  )
}

export function CardHeader({
  label,
  title,
  description,
  actions,
}: {
  label?: ReactNode
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="card-header">
      <div className="card-header__text">
        {label ? <SectionLabel>{label}</SectionLabel> : null}
        {title ? <h2 className="card-title">{title}</h2> : null}
        {description ? <p className="card-desc">{description}</p> : null}
      </div>
      {actions ? <div className="card-header__actions">{actions}</div> : null}
    </div>
  )
}

export function Badge({
  children,
  tone = 'neutral',
  soft = true,
  className,
}: {
  children: ReactNode
  tone?: Tone
  soft?: boolean
  className?: string
}) {
  return <span className={cx('badge', `badge--${tone}`, soft && 'badge--soft', className)}>{children}</span>
}

export function StatusDot({ tone = 'neutral', pulse }: { tone?: Tone; pulse?: boolean }) {
  return <span className={cx('status-dot', `status-dot--${tone}`, pulse && 'status-dot--pulse')} aria-hidden="true" />
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger'

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  block,
  className,
  children,
  type = 'button',
  ...rest
}: {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  icon?: ReactNode
  iconRight?: ReactNode
  block?: boolean
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cx('btn', `btn--${variant}`, `btn--${size}`, block && 'btn--block', className)}
      {...rest}
    >
      {icon ? <span className="btn__icon" aria-hidden="true">{icon}</span> : null}
      {children ? <span className="btn__label">{children}</span> : null}
      {iconRight ? <span className="btn__icon" aria-hidden="true">{iconRight}</span> : null}
    </button>
  )
}

export function IconButton({
  label,
  icon,
  active,
  className,
  ...rest
}: {
  label: string
  icon: ReactNode
  active?: boolean
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'>) {
  return (
    <button type="button" aria-label={label} title={label} className={cx('icon-btn', active && 'icon-btn--active', className)} {...rest}>
      {icon}
    </button>
  )
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
  trailing,
}: {
  label: ReactNode
  htmlFor?: string
  hint?: ReactNode
  children: ReactNode
  className?: string
  trailing?: ReactNode
}) {
  return (
    <div className={cx('field', className)}>
      <div className="field__labelrow">
        <label className="field__label" htmlFor={htmlFor}>
          {label}
        </label>
        {trailing}
      </div>
      {children}
      {hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  )
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx('control', 'control--input', className)} {...rest} />
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx('control', 'control--textarea', className)} {...rest} />
}

export function SelectInput({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="control-select">
      <select className={cx('control', 'control--select', className)} {...rest}>
        {children}
      </select>
      <span className="control-select__chevron" aria-hidden="true">▾</span>
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  id?: string
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx('toggle', checked && 'toggle--on')}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle__thumb" />
    </button>
  )
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: ReactNode
  disabled?: boolean
  id?: string
}) {
  return (
    <label className={cx('checkbox', disabled && 'checkbox--disabled')} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="checkbox__box" aria-hidden="true" />
      <span className="checkbox__label">{label}</span>
    </label>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
  accessibleLabel?: string
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
}: {
  options: SegmentedOption<T>[]
  value: T
  onChange: (next: T) => void
  ariaLabel: string
  size?: 'sm' | 'md'
}) {
  return (
    <div className={cx('segmented', `segmented--${size}`)} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cx('segmented__item', value === option.value && 'segmented__item--active')}
          aria-pressed={value === option.value}
          aria-label={option.accessibleLabel}
          onClick={() => onChange(option.value)}
        >
          {option.icon ? <span className="segmented__icon" aria-hidden="true">{option.icon}</span> : null}
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  id,
  ariaLabel,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (next: number) => void
  id?: string
  ariaLabel?: string
}) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <input
      id={id}
      type="range"
      className="slider"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={ariaLabel}
      style={{ '--slider-fill': `${fill}%` } as CSSProperties}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  )
}

export function ProgressBar({ value, tone = 'accent', label }: { value: number; tone?: Tone; label?: string }) {
  const clamped = Math.max(0, Math.min(1, value))
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      aria-label={label}
    >
      <span className={cx('progress__fill', `progress__fill--${tone}`)} style={{ width: `${clamped * 100}%` }} />
    </div>
  )
}

export function Avatar({ name, tone = 'accent', size = 'md' }: { name: string; tone?: Tone; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={cx('avatar', `avatar--${tone}`, `avatar--${size}`)} aria-hidden="true">
      {name
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((word) => word[0])
        .join('')
        .toUpperCase() || '?'}
    </span>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-state__icon" aria-hidden="true">{icon}</div> : null}
      <p className="empty-state__title">{title}</p>
      {description ? <p className="empty-state__desc">{description}</p> : null}
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  )
}

export function MetaRow({ items }: { items: Array<{ label: ReactNode; value: ReactNode }> }) {
  return (
    <dl className="meta-row">
      {items.map((item, index) => (
        <div className="meta-row__item" key={index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
