export type DataMode = 'live' | 'preview'
export const APP_VERSION = '0.1.5'
export type ThemeMode = 'light' | 'dark' | 'system'
export type Page = 'overview' | 'process' | 'mailbox' | 'evaluation' | 'campaigns' | 'customers' | 'review' | 'value' | 'settings'
export type Complexity = 'simple' | 'multi-intent' | 'ambiguous'
export type RequestClass = 'account-servicing' | 'card-support' | 'payments' | 'lending' | 'savings-investments' | 'complaint' | 'fraud-security' | 'kyc'
export const REQUEST_CLASSES: { value: RequestClass; label: string; description: string }[] = [
  { value: 'account-servicing', label: 'Account servicing', description: 'Statements, account details and service requests' },
  { value: 'card-support', label: 'Card support', description: 'Lost cards, replacement and card servicing' },
  { value: 'payments', label: 'Payments & transfers', description: 'Payment queries, direct debits and transfers' },
  { value: 'lending', label: 'Loans & mortgages', description: 'Repayments, balances and mortgage questions' },
  { value: 'savings-investments', label: 'Savings & investments', description: 'ISA transfers, savings and investment queries' },
  { value: 'complaint', label: 'Complaints', description: 'Escalations and customer dissatisfaction' },
  { value: 'fraud-security', label: 'Fraud & security', description: 'Suspicious activity requiring human attention' },
  { value: 'kyc', label: 'Identity & KYC', description: 'Verification and document requests' },
]
export interface Customer {
  id: string; name: string; email: string; customerNumber: string; accountNumber: string
  kyc: string; risk: string; context: string
}
export interface Product { id: string; name: string; number: string; description: string; state: string }
export interface Holding {
  id: string; customerId: string; productId: string; name: string; number: string; accountNumber: string
  type: string; status: string; balance?: number; cardLastFour?: string; cardStatus?: string; notes: string
}
export interface CaseItem {
  id: string; number: string; title: string; description: string; customerId: string; holdingId?: string
  status: string; state: number; priority: number; category: string; createdAt: string; modifiedAt: string
  owner: string; statusCode: number
}
export interface MailItem {
  id: string; subject: string; from: string; to: string; receivedAt: string; body: string
  hasAttachments: boolean; isRead: boolean; mailbox: string; internetMessageId?: string
}
export interface TaskItem { id: string; subject: string; description: string; caseId: string; status: string; dueAt?: string }
export interface NoteItem { id: string; subject: string; body: string; caseId: string; createdAt: string; filename?: string }
export interface SourceHealth { source: string; status: 'healthy' | 'error' | 'unavailable'; detail: string; count?: number }
export interface WorkflowInfo { id: string; name: string; active: boolean; categories: string[]; helpMailbox: string; description: string }
export interface StudioSnapshot {
  customers: Customer[]; products: Product[]; holdings: Holding[]; cases: CaseItem[]
  messages: MailItem[]; tasks: TaskItem[]; notes: NoteItem[]; workflow?: WorkflowInfo
  health: SourceHealth[]; fetchedAt: string; windowStart: string; mode: DataMode; truncated: string[]
}
export interface Attachment {
  id: string; name: string; mimeType: string; size: number; contentBytes: string
  generated: boolean
}
export interface EmailDraft {
  id: string; customerId: string; holdingId?: string; from: string; to: string; subject: string
  body: string; category: RequestClass; complexity: Complexity; attachments: Attachment[]
  source: 'manual' | 'template' | 'ai'; expectedOutcome: string; runId: string
  state: 'draft' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled'
  error?: string; sentAt?: string
  evaluationVerdict?: 'pass' | 'fail' | 'unscored'; evaluationNotes?: string
}
export interface CampaignConfig {
  customerCount: number; emailCount: number; categories: RequestClass[]; complexity: Complexity
  intervalSeconds: number; source: 'template' | 'ai'; attachment: 'none' | 'pdf' | 'image'
}
export interface GeneratorInput {
  customer: Customer; holding?: Holding; category: RequestClass; complexity: Complexity; index: number
}
export interface GeneratorOutput { subject: string; body: string; expectedOutcome: string }
export interface ReviewChange { priority: number; statusCode: number; note: string }
export interface CostAssumptions {
  monthlyVolume: number; hourlyCost: number; manualMinutes: number; automationRate: number
  automatedMinutes: number; reviewMinutes: number; aiCostPerEmail: number
  connectorCostPerEmail: number; fixedMonthlyCost: number
}
export interface StudioSettings {
  mode: DataMode; theme: ThemeMode; pollSeconds: number; polling: boolean
  helpMailbox: string; senderMailbox: string; aliasSendingConfirmed: boolean
  generationDefinition: string; costs: CostAssumptions
}
export const ENVIRONMENT = {
  id: 'b17908ad-6b6b-eefb-98bc-79cc7e20ab08',
  tenantId: 'fc547a7e-3617-4e9c-a506-83fa37eb5247',
  url: 'https://smc-diamond-service.crm.dynamics.com',
  flowId: 'f1875d78-ffe5-64c8-d7bf-76a7f7a6b63f',
  helpMailbox: 'help@diax47618638.onmicrosoft.com',
  senderMailbox: 'demo.customer@diax47618638.onmicrosoft.com',
  domain: 'diax47618638.onmicrosoft.com',
}
export const DEFAULT_SETTINGS: StudioSettings = {
  mode: new URLSearchParams(window.location.search).get('preview') === 'true' ? 'preview' : 'live',
  theme: 'system', pollSeconds: 10, polling: true,
  helpMailbox: ENVIRONMENT.helpMailbox, senderMailbox: ENVIRONMENT.senderMailbox,
  aliasSendingConfirmed: false, generationDefinition: '',
  costs: { monthlyVolume: 5000, hourlyCost: 32, manualMinutes: 12, automationRate: 0.75,
    automatedMinutes: 1, reviewMinutes: 8, aiCostPerEmail: 0.045,
    connectorCostPerEmail: 0.005, fixedMonthlyCost: 150 },
}
export interface StudioActions {
  navigate: (page: Page) => void
  setSettings: (patch: Partial<StudioSettings>) => void
  refresh: () => Promise<void>
  createDraft: (input: GeneratorInput, source: 'template' | 'ai') => Promise<EmailDraft>
  sendDraft: (draft: EmailDraft) => Promise<void>
  generateCampaign: (config: CampaignConfig) => Promise<void>
  startCampaign: () => Promise<void>
  pauseCampaign: () => void
  cancelCampaign: () => void
  discardCampaign: () => void
  reconcileDraft: (id: string, outcome: 'sent' | 'cancelled') => void
  saveReview: (caseId: string, change: ReviewChange) => Promise<void>
  updateDraft: (draft: EmailDraft) => void
  recordEvaluation: (id: string, verdict: 'pass' | 'fail' | 'unscored', notes: string) => void
  notify: (message: string, kind?: 'success' | 'error' | 'info') => void
}
export interface StudioState {
  page: Page; settings: StudioSettings; snapshot: StudioSnapshot; loading: boolean; refreshing: boolean
  error?: string; drafts: EmailDraft[]; campaignStatus: 'idle' | 'generating' | 'ready' | 'running' | 'paused' | 'completed' | 'cancelled'
  campaignConfig?: CampaignConfig; campaignRunId?: string; campaignProgress: number
  toast?: { message: string; kind: 'success' | 'error' | 'info' }
}
export interface StudioContext { state: StudioState; actions: StudioActions }
