import { createContext, useContext } from 'react'
import type { StudioContext, Page } from '../types'

// UI-only state that is owned by the view layer (never persisted server-side).
export interface UiLocalState {
  // Shared selection used by the Customers page to seed the Evaluation form.
  selectedCustomerId?: string
  selectedHoldingId?: string
  selectCustomer: (customerId?: string, holdingId?: string) => void
  // Navigates to Evaluation with the given customer/holding pre-selected.
  startTestForCustomer: (customerId: string, holdingId?: string) => void
  onboardingDismissed: boolean
  dismissOnboarding: () => void
}

export interface AppContextValue {
  studio: StudioContext
  ui: UiLocalState
}

export const AppContext = createContext<AppContextValue | null>(null)

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside <AppContext.Provider>')
  return ctx
}

export function useStudioState() {
  return useApp().studio.state
}

export function useStudioActions() {
  return useApp().studio.actions
}

export function useUi() {
  return useApp().ui
}

export interface NavItem {
  page: Page
  label: string
  short: string
  hint: string
}

export const NAV_ITEMS: NavItem[] = [
  { page: 'overview', label: 'Overview', short: 'Overview', hint: 'Operational snapshot' },
  { page: 'process', label: 'Process studio', short: 'Process', hint: 'Pipeline configuration' },
  { page: 'mailbox', label: 'Communications', short: 'Inbox', hint: 'Help & demo mailboxes' },
  { page: 'evaluation', label: 'Evaluation', short: 'Evaluate', hint: 'Compose a single test email' },
  { page: 'campaigns', label: 'Campaigns', short: 'Campaigns', hint: 'Generate a batch of tests' },
  { page: 'customers', label: 'Customers', short: 'Customers', hint: 'Contacts, holdings & products' },
  { page: 'review', label: 'Human review', short: 'Review', hint: 'Open cases needing attention' },
  { page: 'value', label: 'Business value', short: 'Value', hint: 'Modelled cost & savings' },
  { page: 'settings', label: 'Settings', short: 'Settings', hint: 'Environment & preferences' },
]

export const PAGE_TITLES: Record<Page, string> = {
  overview: 'Overview',
  process: 'Process studio',
  mailbox: 'Communications',
  evaluation: 'Evaluation suite',
  campaigns: 'Campaigns',
  customers: 'Customers & products',
  review: 'Human review',
  value: 'Business value',
  settings: 'Settings',
}
