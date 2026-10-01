import type { Customer, Holding } from '../types'
import { holdingDisplayName } from './holdingLabels.ts'

const alphabetical = new Intl.Collator('en-GB', { sensitivity: 'base', numeric: true })

export function sortedCustomers(customers: readonly Customer[]): Customer[] {
  return [...customers].sort((a, b) => alphabetical.compare(a.name.trim(), b.name.trim())
    || alphabetical.compare(a.email, b.email) || alphabetical.compare(a.id, b.id))
}

export function sortedHoldings(holdings: readonly Holding[]): Holding[] {
  return [...holdings].sort((a, b) => alphabetical.compare(holdingDisplayName(a), holdingDisplayName(b))
    || alphabetical.compare(a.id, b.id))
}
