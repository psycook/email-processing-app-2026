import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Page } from './types'
import { APP_VERSION } from './types'
import { useStudio } from './hooks/useStudio'
import { AppContext } from './ui/studioContext'
import type { AppContextValue, UiLocalState } from './ui/studioContext'
import { openCases, unreadMessages } from './ui/selectors'
import { Sidebar } from './ui/Sidebar'
import { Topbar } from './ui/Topbar'
import { SystemBanners } from './ui/Banners'
import { ToastRegion } from './ui/Toast'
import { Modal } from './ui/Modal'
import { Button, Spinner } from './ui/primitives'
import { cx } from './ui/util'
import { Orbit, Sparkles, ShieldCheck, Eye } from './ui/icons'
import { OverviewPage } from './pages/Overview'
import { ProcessPage } from './pages/Process'
import { CommunicationsPage } from './pages/Communications'
import { EvaluationPage } from './pages/Evaluation'
import { CampaignsPage } from './pages/Campaigns'
import { CustomersPage } from './pages/Customers'
import { ReviewPage } from './pages/Review'
import { ValuePage } from './pages/Value'
import { SettingsPage } from './pages/Settings'
import './App.css'

const ONBOARDING_KEY = 'gravity.studio.onboarded'

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true
}

function readOnboarded(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_KEY) === '1'
  } catch {
    return false
  }
}

function PageView({ page }: { page: Page }) {
  switch (page) {
    case 'overview':
      return <OverviewPage />
    case 'process':
      return <ProcessPage />
    case 'mailbox':
      return <CommunicationsPage />
    case 'evaluation':
      return <EvaluationPage />
    case 'campaigns':
      return <CampaignsPage />
    case 'customers':
      return <CustomersPage />
    case 'review':
      return <ReviewPage />
    case 'value':
      return <ValuePage />
    case 'settings':
      return <SettingsPage />
    default:
      return <OverviewPage />
  }
}

function App() {
  const studio = useStudio()
  const { state, actions } = studio

  const [selectedCustomerId, setSelectedCustomerId] = useState<string | undefined>(undefined)
  const [selectedHoldingId, setSelectedHoldingId] = useState<string | undefined>(undefined)
  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean>(readOnboarded)
  const [navOpen, setNavOpen] = useState(false)
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark)

  const theme = state.settings.theme
  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = resolvedTheme
    root.style.colorScheme = resolvedTheme
  }, [resolvedTheme])

  useEffect(() => {
    if (!window.matchMedia) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const selectCustomer = useCallback((customerId?: string, holdingId?: string) => {
    setSelectedCustomerId(customerId)
    setSelectedHoldingId(holdingId)
  }, [])

  const startTestForCustomer = useCallback(
    (customerId: string, holdingId?: string) => {
      setSelectedCustomerId(customerId)
      setSelectedHoldingId(holdingId)
      actions.navigate('evaluation')
    },
    [actions],
  )

  const dismissOnboarding = useCallback(() => {
    setOnboardingDismissed(true)
    try {
      window.localStorage.setItem(ONBOARDING_KEY, '1')
    } catch {
      /* ignore storage failures */
    }
  }, [])

  const ui = useMemo<UiLocalState>(
    () => ({
      selectedCustomerId: state.snapshot.customers.some(item => item.id === selectedCustomerId) ? selectedCustomerId : undefined,
      selectedHoldingId: state.snapshot.holdings.some(item => item.id === selectedHoldingId) ? selectedHoldingId : undefined,
      selectCustomer,
      startTestForCustomer,
      onboardingDismissed,
      dismissOnboarding,
    }),
    [selectedCustomerId, selectedHoldingId, selectCustomer, startTestForCustomer, onboardingDismissed, dismissOnboarding, state.snapshot.customers, state.snapshot.holdings],
  )

  const value = useMemo<AppContextValue>(() => ({ studio, ui }), [studio, ui])

  const navigate = useCallback(
    (page: Page) => {
      actions.navigate(page)
      setNavOpen(false)
    },
    [actions],
  )

  const unread = unreadMessages(state.snapshot.messages).length
  const openCaseCount = openCases(state.snapshot).length

  const showOnboarding = !onboardingDismissed

  return (
    <AppContext.Provider value={value}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className={cx('app', navOpen && 'app--nav-open')} data-mode={state.settings.mode}>
        <aside className="app__sidebar" aria-label="Sidebar navigation">
          <Sidebar
            page={state.page}
            mode={state.settings.mode}
            version={APP_VERSION}
            onNavigate={navigate}
            unreadCount={unread}
            openCaseCount={openCaseCount}
          />
        </aside>

        <button
          type="button"
          className="app__scrim"
          aria-label="Close navigation"
          tabIndex={navOpen ? 0 : -1}
          onClick={() => setNavOpen(false)}
        />

        <div className="app__main">
          <Topbar page={state.page} onToggleNav={() => setNavOpen((open) => !open)} />
          <div className="app__banners">
            <SystemBanners
              error={state.error}
              health={state.snapshot.health}
              truncated={state.snapshot.truncated}
              mode={state.settings.mode}
            />
          </div>
          <main id="main-content" className="app__content" tabIndex={-1}>
            {state.loading ? (
              <div className="app__loading" role="status" aria-live="polite">
                <Spinner label="Loading studio" />
                <p>Loading the latest snapshot…</p>
              </div>
            ) : (
              <PageView key={state.settings.mode} page={state.page} />
            )}
          </main>
        </div>
      </div>

      <ToastRegion toast={state.toast} />

      <Modal
        open={showOnboarding}
        onClose={dismissOnboarding}
        size="lg"
        title={
          <span className="welcome__title">
            <span className="welcome__logo" aria-hidden="true"><Orbit size={20} /></span>
            Welcome to the Gravity Email Process Studio
          </span>
        }
        description="A workspace to observe, test and value the email automation — honestly."
        footer={<Button variant="primary" onClick={dismissOnboarding}>Start exploring</Button>}
      >
        <ul className="welcome__points">
          <li>
            <span className="welcome__icon welcome__icon--accent" aria-hidden="true"><Sparkles size={16} /></span>
            <span>
              <strong>Grounded and clearly labelled.</strong> Live data comes from your connectors. Preview uses labelled
              synthetic fixtures; estimated costs are never presented as measured savings.
            </span>
          </li>
          <li>
            <span className="welcome__icon welcome__icon--lavender" aria-hidden="true"><Eye size={16} /></span>
            <span>
              <strong>Read-only until you approve a send.</strong> You can compose and export without changing your environment. Sending is a
              separate, explicit step you control in Settings.
            </span>
          </li>
          <li>
            <span className="welcome__icon welcome__icon--success" aria-hidden="true"><ShieldCheck size={16} /></span>
            <span>
              <strong>Safe to click.</strong> Every email is reviewed before it sends, and generated content is clearly
              labelled as synthetic test data.
            </span>
          </li>
        </ul>
      </Modal>
    </AppContext.Provider>
  )
}

export default App
