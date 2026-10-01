import { useMemo } from 'react'
import type { CostAssumptions } from '../types'
import { estimateCosts, formatMoney, downloadText } from '../lib/studioEngine'
import { useApp } from '../ui/studioContext'
import {
  Card,
  CardHeader,
  SectionLabel,
  Badge,
  Button,
  Field,
  Slider,
  TextInput,
} from '../ui/primitives'
import { InlineNote } from '../ui/Banners'
import { cx } from '../ui/util'
import { Calculator, Download, TrendingUp, Clock, Coins, Scale } from '../ui/icons'

interface AssumptionMeta {
  key: keyof CostAssumptions
  label: string
  hint: string
  min: number
  max: number
  step: number
  kind: 'count' | 'money' | 'minutes' | 'percent'
}

const ASSUMPTIONS: AssumptionMeta[] = [
  { key: 'monthlyVolume', label: 'Monthly email volume', hint: 'Inbound help requests per month.', min: 0, max: 50000, step: 100, kind: 'count' },
  { key: 'hourlyCost', label: 'Fully-loaded hourly cost', hint: 'Average cost of an agent hour.', min: 0, max: 200, step: 1, kind: 'money' },
  { key: 'manualMinutes', label: 'Manual handling (minutes)', hint: 'Minutes to resolve one email by hand.', min: 0, max: 60, step: 0.5, kind: 'minutes' },
  { key: 'automationRate', label: 'Automation rate', hint: 'Share of emails handled automatically.', min: 0, max: 1, step: 0.01, kind: 'percent' },
  { key: 'automatedMinutes', label: 'Assisted handling (minutes)', hint: 'Residual agent minutes on automated emails.', min: 0, max: 30, step: 0.5, kind: 'minutes' },
  { key: 'reviewMinutes', label: 'Human review (minutes)', hint: 'Minutes spent reviewing automated output.', min: 0, max: 60, step: 0.5, kind: 'minutes' },
  { key: 'aiCostPerEmail', label: 'AI cost per email', hint: 'Model/generation cost per automated email.', min: 0, max: 1, step: 0.005, kind: 'money' },
  { key: 'connectorCostPerEmail', label: 'Connector cost per email', hint: 'Metered connector cost per email.', min: 0, max: 0.5, step: 0.005, kind: 'money' },
  { key: 'fixedMonthlyCost', label: 'Fixed platform cost', hint: 'Flat monthly platform and licence cost.', min: 0, max: 5000, step: 10, kind: 'money' },
]

function formatValue(meta: AssumptionMeta, value: number): string {
  switch (meta.kind) {
    case 'money':
      return formatMoney(value)
    case 'percent':
      return `${Math.round(value * 100)}%`
    case 'minutes':
      return `${value} min`
    default:
      return value.toLocaleString()
  }
}

export function ValuePage() {
  const { studio } = useApp()
  const { state, actions } = studio
  const costs = state.settings.costs

  const estimate = useMemo(() => estimateCosts(costs), [costs])

  const setCost = (key: keyof CostAssumptions, value: number) => {
    actions.setSettings({ costs: { ...costs, [key]: value } })
  }

  const aiCost = Math.max(0, costs.monthlyVolume * costs.automationRate * costs.aiCostPerEmail)
  const connectorCost = Math.max(0, costs.monthlyVolume * costs.connectorCostPerEmail)
  const fixedCost = Math.max(0, costs.fixedMonthlyCost)
  const labourCost = Math.max(0, estimate.automatedCost - aiCost - connectorCost - fixedCost)

  const composition = [
    { label: 'Labour (handling + review)', value: labourCost, tone: 'accent' as const },
    { label: 'AI generation', value: aiCost, tone: 'lavender' as const },
    { label: 'Connectors', value: connectorCost, tone: 'info' as const },
    { label: 'Fixed platform', value: fixedCost, tone: 'neutral' as const },
  ]
  const scale = Math.max(estimate.manualCost, estimate.automatedCost, 1)

  const metrics = [
    { label: 'Manual cost / month', value: formatMoney(estimate.manualCost), icon: <Coins size={16} />, tone: 'neutral' as const },
    { label: 'Automated cost / month', value: formatMoney(estimate.automatedCost), icon: <Coins size={16} />, tone: 'accent' as const },
    { label: 'Monthly saving', value: formatMoney(estimate.monthlySavings), icon: <TrendingUp size={16} />, tone: 'success' as const },
    { label: 'Annual saving', value: formatMoney(estimate.annualSavings), icon: <TrendingUp size={16} />, tone: 'success' as const },
    { label: 'Cost per email', value: formatMoney(estimate.costPerEmail), icon: <Scale size={16} />, tone: 'neutral' as const },
    { label: 'Agent hours saved / month', value: Math.round(estimate.hoursSaved).toLocaleString(), icon: <Clock size={16} />, tone: 'lavender' as const },
    { label: 'Return on investment', value: `${Math.round(estimate.roi * 100)}%`, icon: <TrendingUp size={16} />, tone: 'success' as const },
    { label: 'Break-even volume / month', value: Math.round(estimate.breakEvenVolume).toLocaleString(), icon: <Scale size={16} />, tone: 'neutral' as const },
  ]

  const exportSnapshot = () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      note: 'Modelled estimate from user assumptions. Not a measured or invoiced figure.',
      assumptions: costs,
      estimate,
      composition: { labourCost, aiCost, connectorCost, fixedCost },
    }
    downloadText('gravity-business-value.json', JSON.stringify(payload, null, 2), 'application/json')
    actions.notify('Value snapshot exported', 'success')
  }

  return (
    <div className="page">
      <section className="page-head">
        <div>
          <SectionLabel>Business value</SectionLabel>
          <h1 className="page-title">The economics, modelled from your assumptions</h1>
          <p className="page-lede">
            Adjust the inputs to see how automation changes cost and capacity. Every figure here is a model estimate — not
            a measured result or an invoice.
          </p>
        </div>
        <Button variant="secondary" icon={<Download size={15} />} onClick={exportSnapshot}>
          Export snapshot
        </Button>
      </section>

      <InlineNote tone="info">
        These numbers are produced from the assumptions below. They illustrate potential impact and should be validated
        against your own operational and billing data before being used in a business case.
      </InlineNote>

      <div className="value-layout">
        <Card className="value-inputs">
          <CardHeader label="Assumptions" title={<><Calculator size={15} /> Cost model inputs</>} description="Defaults reflect a mid-size service team. Tune to match your operation." />
          <div className="assumption-grid">
            {ASSUMPTIONS.map((meta) => {
              const value = costs[meta.key]
              return (
                <Field
                  key={meta.key}
                  label={meta.label}
                  htmlFor={`cost-${meta.key}`}
                  hint={meta.hint}
                  trailing={<Badge soft tone="neutral">{formatValue(meta, value)}</Badge>}
                >
                  <div className="assumption-control">
                    <Slider
                      id={`cost-${meta.key}`}
                      ariaLabel={meta.label}
                      value={value}
                      min={meta.min}
                      max={meta.max}
                      step={meta.step}
                      onChange={(next) => setCost(meta.key, next)}
                    />
                    <TextInput
                      type="number"
                      className="assumption-number"
                      aria-label={`${meta.label} exact value`}
                      value={value}
                      min={meta.min}
                      max={meta.max}
                      step={meta.step}
                      onChange={(event) => {
                        const next = Number(event.target.value)
                        if (Number.isFinite(next)) setCost(meta.key, Math.min(meta.max, Math.max(meta.min, next)))
                      }}
                    />
                  </div>
                </Field>
              )
            })}
          </div>
        </Card>

        <div className="value-results">
          <div className="metric-grid">
            {metrics.map((metric) => (
              <Card key={metric.label} className="metric-card">
                <div className={cx('metric-card__icon', `metric-card__icon--${metric.tone}`)} aria-hidden="true">{metric.icon}</div>
                <div className="metric-card__body">
                  <p className="metric-card__value">{metric.value}</p>
                  <p className="metric-card__label">{metric.label}</p>
                </div>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader
              label="Waterfall"
              title="Where the money goes"
              description="Manual baseline versus modelled automated operating cost. Labour is the residual after technology costs."
            />
            <div className="waterfall">
              <div className="waterfall__row">
                <span className="waterfall__name">Manual today</span>
                <div className="waterfall__track">
                  <span className="waterfall__seg waterfall__seg--neutral" style={{ width: `${(estimate.manualCost / scale) * 100}%` }} />
                </div>
                <span className="waterfall__total">{formatMoney(estimate.manualCost)}</span>
              </div>
              <div className="waterfall__row">
                <span className="waterfall__name">Automated</span>
                <div className="waterfall__track">
                  {composition.map((segment) => (
                    <span
                      key={segment.label}
                      className={cx('waterfall__seg', `waterfall__seg--${segment.tone}`)}
                      style={{ width: `${(segment.value / scale) * 100}%` }}
                      title={`${segment.label}: ${formatMoney(segment.value)}`}
                    />
                  ))}
                </div>
                <span className="waterfall__total">{formatMoney(estimate.automatedCost)}</span>
              </div>
            </div>
            <div className="waterfall__saving">
              <span>Modelled monthly saving</span>
              <strong>{formatMoney(estimate.monthlySavings)}</strong>
            </div>
            <div className="legend">
              {composition.map((segment) => (
                <span key={segment.label} className="legend__item">
                  <span className={cx('legend__swatch', `legend__swatch--${segment.tone}`)} aria-hidden="true" />
                  {segment.label}
                </span>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader label="Breakdown" title="Modelled monthly composition" />
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Component</th>
                  <th scope="col" className="num">Monthly</th>
                  <th scope="col" className="num">Share</th>
                </tr>
              </thead>
              <tbody>
                {composition.map((segment) => (
                  <tr key={segment.label}>
                    <th scope="row">
                      <span className={cx('legend__swatch', `legend__swatch--${segment.tone}`)} aria-hidden="true" /> {segment.label}
                    </th>
                    <td className="num">{formatMoney(segment.value)}</td>
                    <td className="num">{estimate.automatedCost > 0 ? `${Math.round((segment.value / estimate.automatedCost) * 100)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Automated total</th>
                  <td className="num">{formatMoney(estimate.automatedCost)}</td>
                  <td className="num">100%</td>
                </tr>
              </tfoot>
            </table>
            <p className="muted-note">Figures are modelled estimates, not measured or invoiced costs.</p>
          </Card>
        </div>
      </div>
    </div>
  )
}
