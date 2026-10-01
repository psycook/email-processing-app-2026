import type {
  CaseItem,
  Customer,
  Holding,
  MailItem,
  NoteItem,
  Product,
  RequestClass,
  StudioSnapshot,
  TaskItem,
} from '../types'
import { REQUEST_CLASSES } from '../types'

export function isOpenCase(item: CaseItem): boolean {
  return item.state === 0
}

export function openCases(snapshot: StudioSnapshot): CaseItem[] {
  return snapshot.cases.filter(isOpenCase)
}

export function unreadMessages(messages: MailItem[]): MailItem[] {
  return messages.filter((message) => !message.isRead)
}

export function messagesForMailbox(snapshot: StudioSnapshot, mailbox: string): MailItem[] {
  return snapshot.messages.filter(message => message.mailbox === mailbox)
}

export function sourceHealthy(snapshot: StudioSnapshot, source: string): boolean {
  return snapshot.health.find(item => item.source === source)?.status === 'healthy'
}

export function customerById(snapshot: StudioSnapshot, id?: string): Customer | undefined {
  if (!id) return undefined
  return snapshot.customers.find((customer) => customer.id === id)
}

export function productById(snapshot: StudioSnapshot, id?: string): Product | undefined {
  if (!id) return undefined
  return snapshot.products.find((product) => product.id === id)
}

export function holdingsForCustomer(snapshot: StudioSnapshot, customerId?: string): Holding[] {
  if (!customerId) return []
  return snapshot.holdings.filter((holding) => holding.customerId === customerId)
}

export function casesForCustomer(snapshot: StudioSnapshot, customerId?: string): CaseItem[] {
  if (!customerId) return []
  return snapshot.cases.filter((item) => item.customerId === customerId)
}

export function notesForCase(snapshot: StudioSnapshot, caseId: string): NoteItem[] {
  return snapshot.notes.filter((note) => note.caseId === caseId)
}

export function tasksForCase(snapshot: StudioSnapshot, caseId: string): TaskItem[] {
  return snapshot.tasks.filter((task) => task.caseId === caseId)
}

export function holdingsForProduct(snapshot: StudioSnapshot, productId: string): Holding[] {
  return snapshot.holdings.filter((holding) => holding.productId === productId)
}

export function sortByReceived(messages: MailItem[]): MailItem[] {
  return [...messages].sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
}

export function sortCasesByModified(cases: CaseItem[]): CaseItem[] {
  return [...cases].sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
}

export interface CategoryCount {
  category: string
  count: number
}

// Distribution of CRM case categories (what the system actually records).
export function caseCategoryMix(cases: CaseItem[]): CategoryCount[] {
  const counts = new Map<string, number>()
  for (const item of cases) {
    const key = item.category?.trim() || 'Uncategorised'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
}

export const EXPECTED_CLASS_LABELS: { value: RequestClass; label: string }[] = REQUEST_CLASSES.map((item) => ({
  value: item.value,
  label: item.label,
}))

export function totalBalance(holdings: Holding[]): number {
  return holdings.reduce((sum, holding) => sum + (holding.balance ?? 0), 0)
}
