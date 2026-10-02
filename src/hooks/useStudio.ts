import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, ENVIRONMENT, REQUEST_CLASSES } from '../types'
import type { CampaignConfig, EmailDraft, GeneratorInput, ReviewChange, StudioContext, StudioSettings, StudioState } from '../types'
import { emptySnapshot, previewSnapshot } from '../services/previewData'
import { createDocumentAttachment, generateTemplate, makeDraft, matchingHolding, validateDraft } from '../lib/studioEngine'

const PREFS_KEY = 'gravity.studio.preferences.v1'
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The operation failed with an unspecified error.'
const isUnknownSend = (error: unknown) => messageOf(error).startsWith('SendEmailV2 outcome is unknown:')
const busyStatuses = new Set<StudioState['campaignStatus']>(['running', 'paused', 'generating'])
const gateway = () => import('../services/studioGateway')

function initialState(): StudioState {
  const settings = { ...DEFAULT_SETTINGS, costs: { ...DEFAULT_SETTINGS.costs } }
  let preferenceError: string | undefined
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null')
    if (saved && typeof saved === 'object' && 'theme' in saved && ['light', 'dark', 'system'].includes(String(saved.theme))) {
      settings.theme = saved.theme === 'light' ? 'light' : saved.theme === 'dark' ? 'dark' : 'system'
    }
    if (saved && typeof saved === 'object' && 'costs' in saved && saved.costs && typeof saved.costs === 'object') {
      for (const key of Object.keys(settings.costs)) {
        const value: unknown = Reflect.get(saved.costs, key)
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && (key !== 'automationRate' || value <= 1)) {
          Reflect.set(settings.costs, key, value)
        }
      }
    }
  } catch (error) {
    preferenceError = `Saved preferences could not be read: ${messageOf(error)}. Default assumptions are in use.`
  }
  return { page: 'overview', settings, snapshot: emptySnapshot(settings.mode), loading: true, refreshing: false,
    drafts: [], campaignStatus: 'idle', campaignProgress: 0,
    toast: preferenceError ? { kind: 'error', message: preferenceError } : undefined }
}

export function useStudio(): StudioContext {
  const [state, setState] = useState<StudioState>(initialState)
  const stateRef = useRef(state)
  const epoch = useRef(0)
  const generationEpoch = useRef(0)
  const refreshJob = useRef<Promise<void> | undefined>(undefined)
  const runner = useRef<Promise<void> | undefined>(undefined)
  const wakeRunner = useRef<(() => void) | undefined>(undefined)
  const sending = useRef(new Set<string>())
  const alive = useRef(true)

  const commit = useCallback((patch: Partial<StudioState>) => {
    stateRef.current = { ...stateRef.current, ...patch }
    if (alive.current) setState(stateRef.current)
  }, [])
  const notify = useCallback((message: string, kind: 'success' | 'error' | 'info' = 'info') => {
    commit({ toast: { message, kind } })
  }, [commit])

  const refresh = useCallback(async () => {
    if (refreshJob.current) return refreshJob.current
    const requestedEpoch = epoch.current
    const settings = stateRef.current.settings
    const job = (async () => {
      commit({ refreshing: true })
      try {
        const snapshot = settings.mode === 'preview' ? previewSnapshot() : await (await gateway()).fetchSnapshot(settings)
        if (requestedEpoch !== epoch.current || !alive.current) return
        // Retain local-only preview review edits between refreshes.
        const previous = stateRef.current.snapshot
        if (settings.mode === 'preview' && previous.mode === 'preview' && previous.fetchedAt) {
          snapshot.cases = previous.cases
          snapshot.notes = previous.notes
        }
        commit({ snapshot, error: undefined })
      } catch (error) {
        if (requestedEpoch === epoch.current) commit({ error: messageOf(error) })
      } finally {
        if (requestedEpoch === epoch.current) commit({ loading: false, refreshing: false })
      }
    })()
    refreshJob.current = job
    try { await job } finally { if (refreshJob.current === job) refreshJob.current = undefined }
  }, [commit])

  const setSettings = useCallback((patch: Partial<StudioSettings>) => {
    const current = stateRef.current
    if (patch.mode && patch.mode !== current.settings.mode
      && (busyStatuses.has(current.campaignStatus) || sending.current.size)) {
      notify('Finish or cancel pending operations before changing data mode.', 'error')
      return
    }
    const settings = { ...current.settings, ...patch }
    if (settings.helpMailbox !== ENVIRONMENT.helpMailbox || settings.senderMailbox !== ENVIRONMENT.senderMailbox) {
      notify('This Studio is bound to the configured Gravity demo mailboxes.', 'error')
      return
    }
    settings.pollSeconds = Math.max(10, Math.min(120, settings.pollSeconds))
    if (Object.values(settings.costs).some(value => !Number.isFinite(value) || value < 0) || settings.costs.automationRate > 1) {
      notify('Cost assumptions must be nonnegative and finite, with an automation rate between zero and one.', 'error')
      return
    }
    if (settings.mode !== current.settings.mode) {
      epoch.current++; generationEpoch.current++
      settings.replyToWorkflowConfirmed = false
      refreshJob.current = undefined
      commit({ settings, snapshot: emptySnapshot(settings.mode), loading: true, refreshing: false, drafts: [],
        campaignStatus: 'idle', campaignRunId: undefined, campaignConfig: undefined, campaignProgress: 0, error: undefined })
    } else commit({ settings })
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: settings.theme, costs: settings.costs })) }
    catch (error) { notify(`Preferences are session-only because they could not be saved: ${messageOf(error)}`, 'error') }
  }, [commit, notify])

  const putDraft = useCallback((draft: EmailDraft) => {
    const drafts = stateRef.current.drafts
    commit({ drafts: drafts.some(item => item.id === draft.id)
      ? drafts.map(item => item.id === draft.id ? draft : item) : [...drafts, draft] })
  }, [commit])

  const checkInput = useCallback((input: GeneratorInput) => {
    const snapshot = stateRef.current.snapshot
    const customer = snapshot.customers.find(item => item.id === input.customer.id)
    if (!customer || customer.email !== input.customer.email) throw new Error('Select a customer from the current data mode.')
    if (input.holding && !snapshot.holdings.some(item => item.id === input.holding?.id && item.customerId === customer.id)) {
      throw new Error('Select a financial holding linked to this customer.')
    }
  }, [])

  const createDraft = useCallback(async (input: GeneratorInput, source: 'template' | 'ai') => {
    checkInput(input)
    const requestedEpoch = epoch.current
    const settings = stateRef.current.settings
    if (source === 'ai' && settings.mode === 'preview') throw new Error('AI generation requires live mode. Preview templates are not labelled AI.')
    const output = source === 'ai' ? await (await gateway()).generateAI(input, settings) : generateTemplate(input)
    if (requestedEpoch !== epoch.current || !alive.current) throw new Error('Data mode changed during generation; the result was discarded.')
    const draft = makeDraft(input, output, source, settings, `single-${crypto.randomUUID().slice(0, 8)}`)
    putDraft(draft)
    return draft
  }, [checkInput, putDraft])

  const updateDraft = useCallback((draft: EmailDraft) => {
    const existing = stateRef.current.drafts.find(item => item.id === draft.id)
    if (!existing || !['draft', 'failed'].includes(existing.state) || sending.current.has(draft.id)) {
      notify('Sent, pending, cancelled and uncertain drafts are locked. Create a new test instead.', 'error')
      return
    }
    if (draft.customerId !== existing.customerId || draft.from !== existing.from || draft.replyTo !== existing.replyTo || draft.to !== existing.to || draft.runId !== existing.runId) {
      notify('From, Reply-To, customer, recipient and run identity cannot be changed on an existing draft.', 'error')
      return
    }
    putDraft({ ...draft, state: existing.state })
  }, [notify, putDraft])

  const sendDraft = useCallback(async (draft: EmailDraft) => {
    const current = stateRef.current
    const existing = current.drafts.find(item => item.id === draft.id)
    if (!existing || !['draft', 'failed'].includes(existing.state) || sending.current.has(draft.id)) throw new Error('This draft is locked, already submitted, or not in the current session.')
    if (existing.runId !== draft.runId || existing.from !== draft.from || existing.replyTo !== draft.replyTo || existing.to !== draft.to || existing.customerId !== draft.customerId) throw new Error('The reviewed draft identity changed.')
    if (current.settings.mode !== 'live') throw new Error('Preview never sends a real email.')
    if (!current.settings.replyToWorkflowConfirmed) throw new Error('Confirm the demo workflow uses the customer Reply-To address in Settings before sending.')
    validateDraft(draft)
    sending.current.add(draft.id)
    putDraft({ ...draft, state: 'sending', error: undefined })
    try {
      await (await gateway()).sendEmail(draft, current.settings)
      putDraft({ ...draft, state: 'sent', error: undefined, sentAt: new Date().toISOString() })
      notify('Connector accepted the email. Confirm the received Reply-To matches the customer alias; the delivered From may be the shared mailbox.', 'success')
      void refresh()
    } catch (error) {
      putDraft({ ...draft, state: isUnknownSend(error) ? 'unknown' : 'failed', error: messageOf(error) })
      throw error
    } finally { sending.current.delete(draft.id) }
  }, [putDraft, refresh, notify])

  const generateCampaign = useCallback(async (config: CampaignConfig) => {
    const current = stateRef.current
    if (busyStatuses.has(current.campaignStatus) || runner.current || sending.current.size) throw new Error('Finish or cancel the current campaign before generating another.')
    if (current.campaignRunId) throw new Error('Export or inspect the existing queue, then explicitly discard it before generating another.')
    if (!Number.isSafeInteger(config.customerCount) || config.customerCount < 1 || config.customerCount > current.snapshot.customers.length
      || !Number.isSafeInteger(config.emailCount) || config.emailCount < config.customerCount || config.emailCount > 200
      || !config.categories.length || config.categories.some(category => !REQUEST_CLASSES.some(item => item.value === category))
      || !Number.isFinite(config.intervalSeconds) || config.intervalSeconds < 1 || config.intervalSeconds > 120) {
      throw new Error('Choose available customers, at least one class, 1–200 emails (at least one per customer), and a 1–120 second interval.')
    }
    if (config.source === 'ai' && current.settings.mode === 'preview') throw new Error('AI generation needs live mode. Use labelled templates to explore preview.')
    const eligible = current.snapshot.customers.filter(customer => customer.email.endsWith(`@${ENVIRONMENT.domain}`))
    if (eligible.length < config.customerCount) throw new Error('Not enough customers have a configured demo-domain email.')
    const customers = eligible.slice(0, config.customerCount)
    const requestedEpoch = epoch.current
    const generation = ++generationEpoch.current
    const runId = `batch-${crypto.randomUUID().slice(0, 8)}`
    commit({ campaignConfig: { ...config, categories: [...config.categories] }, campaignRunId: runId,
      campaignStatus: 'generating', campaignProgress: 0,
      drafts: current.drafts.filter(item => item.runId.startsWith('single-')) })
    try {
      for (let index = 0; index < config.emailCount; index++) {
        if (generation !== generationEpoch.current || requestedEpoch !== epoch.current || !alive.current) return
        const customer = customers[index % customers.length]
        const category = config.categories[index % config.categories.length]
        const customerHoldings = current.snapshot.holdings.filter(item => item.customerId === customer.id)
        const input: GeneratorInput = { customer, category, complexity: config.complexity, index,
          holding: matchingHolding(customerHoldings, category) }
        const output = config.source === 'ai' ? await (await gateway()).generateAI(input, current.settings) : generateTemplate(input)
        const draft = makeDraft(input, output, config.source, current.settings, runId)
        if (config.attachment !== 'none') draft.attachments = [await createDocumentAttachment(config.attachment, customer, input.holding)]
        if (generation !== generationEpoch.current || requestedEpoch !== epoch.current || !alive.current) return
        putDraft(draft)
        commit({ campaignProgress: (index + 1) / config.emailCount })
        await new Promise<void>(resolve => window.setTimeout(resolve, 0))
      }
      commit({ campaignStatus: 'ready' })
      notify(`${config.emailCount} drafts generated for ${customers.length} customers. Review the queue before sending.`, 'success')
    } catch (error) {
      if (generation === generationEpoch.current) commit({ campaignStatus: 'cancelled' })
      throw new Error(`Generation stopped: ${messageOf(error)}. Partial drafts are retained for inspection; this incomplete batch cannot launch.`)
    }
  }, [commit, notify, putDraft])

  const startCampaign = useCallback(async () => {
    const current = stateRef.current
    if (!['ready', 'paused'].includes(current.campaignStatus)) throw new Error('Generate and review a complete batch first.')
    if (runner.current) throw new Error('The current in-flight email is finishing. Wait before resuming.')
    if (current.settings.mode !== 'live' || !current.settings.replyToWorkflowConfirmed) throw new Error('Live mode and confirmation that the demo workflow uses Reply-To are required before launch.')
    const queue = current.drafts.filter(item => item.runId === current.campaignRunId)
    if (queue.length !== current.campaignConfig?.emailCount || queue.some(item => item.state === 'unknown')) throw new Error('The queue is incomplete or contains uncertain sends. Reconcile those before resuming.')
    queue.filter(item => ['draft', 'failed'].includes(item.state)).forEach(validateDraft)
    const settings = { ...current.settings }
    const runId = current.campaignRunId
    commit({ campaignStatus: 'running' })
    const job = (async () => {
      for (const reviewed of queue) {
        if (!alive.current || stateRef.current.campaignStatus !== 'running' || stateRef.current.campaignRunId !== runId) return
        const draft = stateRef.current.drafts.find(item => item.id === reviewed.id)
        if (!draft || !['draft', 'failed'].includes(draft.state)) continue
        if (!stateRef.current.settings.replyToWorkflowConfirmed || stateRef.current.settings.mode !== 'live') {
          commit({ campaignStatus: 'paused' }); notify('Sending permission was withdrawn; the queue is paused.', 'info'); return
        }
        sending.current.add(draft.id)
        putDraft({ ...draft, state: 'sending', error: undefined })
        try {
          await (await gateway()).sendEmail(draft, settings)
          putDraft({ ...draft, state: 'sent', error: undefined, sentAt: new Date().toISOString() })
        } catch (error) {
          putDraft({ ...draft, state: isUnknownSend(error) ? 'unknown' : 'failed', error: messageOf(error) })
          if (stateRef.current.campaignStatus === 'running') commit({ campaignStatus: 'paused' })
          notify(`Campaign paused: ${messageOf(error)}`, 'error')
          return
        } finally { sending.current.delete(draft.id) }
        const done = stateRef.current.drafts.filter(item => item.runId === runId && ['sent', 'cancelled'].includes(item.state)).length
        commit({ campaignProgress: done / queue.length })
        void refresh()
        await new Promise<void>(resolve => {
          const finish = () => { window.clearTimeout(timer); wakeRunner.current = undefined; resolve() }
          const timer = window.setTimeout(finish, (current.campaignConfig?.intervalSeconds ?? 3) * 1000)
          wakeRunner.current = finish
          if (stateRef.current.campaignStatus !== 'running') finish()
        })
      }
      if (stateRef.current.campaignStatus === 'running') {
        commit({ campaignStatus: 'completed' })
        notify('All campaign emails were accepted by the connector. Delivery and workflow outcomes remain observable separately.', 'success')
      }
    })()
    runner.current = job
    void job.catch(error => { commit({ campaignStatus: 'paused' }); notify(messageOf(error), 'error') })
      .finally(() => { if (runner.current === job) runner.current = undefined })
  }, [commit, notify, putDraft, refresh])

  const pauseCampaign = useCallback(() => {
    if (stateRef.current.campaignStatus !== 'running') return
    commit({ campaignStatus: 'paused' })
    wakeRunner.current?.()
    notify('Paused. Any already-submitted email will finish; unsent drafts are held.', 'info')
  }, [commit, notify])
  const cancelCampaign = useCallback(() => {
    generationEpoch.current++
    const current = stateRef.current
    commit({ campaignStatus: 'cancelled', drafts: current.drafts.map(item =>
      item.runId === current.campaignRunId && ['draft', 'failed'].includes(item.state) ? { ...item, state: 'cancelled' } : item) })
    wakeRunner.current?.()
    notify('Unsent campaign drafts cancelled. An in-flight submission cannot be recalled.', 'info')
  }, [commit, notify])
  const discardCampaign = useCallback(() => {
    if (sending.current.size || runner.current || stateRef.current.campaignStatus === 'generating') { notify('Wait for in-flight operations before discarding.', 'error'); return }
    const current = stateRef.current
    if (current.drafts.some(item => item.runId === current.campaignRunId && item.state === 'unknown')) {
      notify('Reconcile uncertain sends before discarding their evidence.', 'error'); return
    }
    commit({ drafts: current.drafts.filter(item => item.runId !== current.campaignRunId), campaignStatus: 'idle',
      campaignRunId: undefined, campaignProgress: 0, campaignConfig: undefined })
  }, [commit, notify])
  const reconcileDraft = useCallback((id: string, outcome: 'sent' | 'cancelled') => {
    const draft = stateRef.current.drafts.find(item => item.id === id)
    if (!draft || draft.state !== 'unknown') { notify('Only an uncertain send can be reconciled.', 'error'); return }
    putDraft({ ...draft, state: outcome, error: `Manually reconciled as ${outcome}; this is not connector delivery proof.` })
    notify('Manual reconciliation recorded for this session.', 'info')
  }, [putDraft, notify])
  const saveReview = useCallback(async (caseId: string, change: ReviewChange) => {
    const current = stateRef.current
    if (current.settings.mode === 'preview') {
      const item = current.snapshot.cases.find(item => item.id === caseId)
      if (!item || item.state !== 0 || !change.note.trim()) throw new Error('Choose an open case and add a review note.')
      commit({ snapshot: { ...current.snapshot,
        cases: current.snapshot.cases.map(item => item.id === caseId ? { ...item, priority: change.priority,
          statusCode: change.statusCode, status: ({ 1: 'In Progress', 2: 'On Hold', 3: 'Waiting for Details', 4: 'Researching' } as Record<number, string>)[change.statusCode], modifiedAt: new Date().toISOString() } : item),
        notes: [...current.snapshot.notes, { id: `preview-${crypto.randomUUID()}`, caseId, subject: 'Preview human review',
          body: change.note, createdAt: new Date().toISOString() }],
      } })
      notify('Preview review saved locally; no Dataverse changes were made.', 'success')
      return
    }
    await (await gateway()).saveCaseReview(caseId, change)
    await refresh()
    notify('Case status, priority and review note saved in Dataverse.', 'success')
  }, [commit, refresh, notify])
  const recordEvaluation = useCallback((id: string, verdict: 'pass' | 'fail' | 'unscored', notes: string) => {
    const draft = stateRef.current.drafts.find(item => item.id === id)
    if (!draft) { notify('The test is no longer in this session.', 'error'); return }
    putDraft({ ...draft, evaluationVerdict: verdict, evaluationNotes: notes })
    notify('Reviewer verdict recorded locally. Export the report to retain it.', 'success')
  }, [putDraft, notify])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; wakeRunner.current?.() }
  }, [])
  useEffect(() => {
    let disposed = false
    let ticking = false
    let timer: number | undefined
    const tick = async () => {
      if (disposed || ticking) return
      ticking = true
      if (document.visibilityState === 'visible') await refresh()
      ticking = false
      if (!disposed && state.settings.polling) timer = window.setTimeout(() => { void tick() }, state.settings.pollSeconds * 1000)
    }
    timer = window.setTimeout(() => { void tick() }, 0)
    const visible = () => { if (document.visibilityState === 'visible') { window.clearTimeout(timer); void tick() } }
    document.addEventListener('visibilitychange', visible)
    return () => { disposed = true; window.clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [refresh, state.settings.mode, state.settings.pollSeconds, state.settings.polling])
  useEffect(() => {
    if (!state.toast) return
    const timer = window.setTimeout(() => commit({ toast: undefined }), 6500)
    return () => window.clearTimeout(timer)
  }, [state.toast, commit])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (busyStatuses.has(stateRef.current.campaignStatus) || sending.current.size) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const actions = useMemo<StudioContext['actions']>(() => ({
    navigate: page => { commit({ page }); window.scrollTo({ top: 0, behavior: 'instant' }) }, setSettings, refresh, createDraft, sendDraft, generateCampaign,
    startCampaign, pauseCampaign, cancelCampaign, discardCampaign, reconcileDraft, saveReview, updateDraft, recordEvaluation, notify,
  }), [commit, setSettings, refresh, createDraft, sendDraft, generateCampaign, startCampaign, pauseCampaign, cancelCampaign,
    discardCampaign, reconcileDraft, saveReview, updateDraft, recordEvaluation, notify])
  return { state, actions }
}
