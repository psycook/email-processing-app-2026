import type { Holding } from '../types'

export function holdingSuffix(holding: Holding): string | undefined {
  if (/^(?:debit|credit) card$/i.test(holding.type)) {
    return holding.cardLastFour && /^\d{4}$/.test(holding.cardLastFour) ? holding.cardLastFour : undefined
  }
  return /^\d{8}$/.test(holding.accountNumber) ? holding.accountNumber.slice(-4) : undefined
}

export function holdingDisplayName(holding: Holding): string {
  let label = holding.name.trim().replace(/\s+/g, ' ')
    .replace(/\s*[-\u2013\u2014|:]\s*DEMO-(?:CUST|HLD)-[A-Za-z0-9-]+\s*$/i, '')
    .replace(/^Demo\s+/i, '')
    .replace(/^Diamond\b/i, 'Gravity')
    .replace(/\s+ending\s+\d{4}$/i, '')
  if (/\bCurrent$/i.test(label)) label += ' Account'
  if (!/^Gravity\b/i.test(label)) label = `Gravity ${label || holding.type}`
  const suffix = holdingSuffix(holding)
  return `${label}${suffix ? ` ending ${suffix}` : ''}`
}

export function holdingEmailReference(holding: Holding): string {
  return holdingDisplayName(holding).replace(/^Gravity\s+/i, 'my ')
}
