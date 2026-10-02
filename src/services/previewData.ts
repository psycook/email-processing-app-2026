import { ENVIRONMENT, REQUEST_CLASSES } from '../types'
import type { StudioSnapshot, Customer, Holding, Product, CaseItem, MailItem, TaskItem, NoteItem } from '../types'

export function emptySnapshot(mode: StudioSnapshot['mode']): StudioSnapshot {
  return { customers: [], products: [], holdings: [], cases: [], messages: [], tasks: [], notes: [],
    health: [], fetchedAt: '', windowStart: '', mode, truncated: [] }
}

export function previewSnapshot(): StudioSnapshot {
  const names = ['Adam Linton', 'Aisha Talbot', 'Alexander Eastwood', 'Alfie Corbett', 'Alice Iqbal', 'Amelia Wallace', 'Anika Kapoor', 'Archie Radcliffe', 'Aria Bellamy', 'Arjun Yardley', 'Arthur Kershaw', 'Ava Xu']
  const products: Product[] = [
    { id: 'preview-current', name: 'Gravity Everyday', number: 'GB-CUR-01', description: 'Everyday current account with digital servicing.', state: 'Active' },
    { id: 'preview-savings', name: 'Gravity Orbit Saver', number: 'GB-SAV-01', description: 'Flexible savings, made straightforward.', state: 'Active' },
    { id: 'preview-card', name: 'Gravity Debit Card', number: 'GB-CRD-01', description: 'A card for your everyday orbit.', state: 'Active' },
    { id: 'preview-mortgage', name: 'Gravity Home', number: 'GB-MTG-01', description: 'A mortgage for your next chapter.', state: 'Active' },
    { id: 'preview-isa', name: 'Gravity Cash ISA', number: 'GB-ISA-01', description: 'Tax-efficient saving for your goals.', state: 'Active' },
    { id: 'preview-loan', name: 'Gravity Personal Loan', number: 'GB-LON-01', description: 'Lending for the moments that matter.', state: 'Active' },
  ]
  const customers: Customer[] = names.map((name, index) => ({
    id: `preview-customer-${index}`, name, email: `${name.toLowerCase().replaceAll(' ', '.')}@${ENVIRONMENT.domain}`,
    customerNumber: `PREVIEW-CUST-${String(index + 1).padStart(4, '0')}`, accountNumber: `DEMO-${String(index + 1).padStart(6, '0')}`,
    kyc: index % 5 === 0 ? 'Review due' : 'Verified', risk: index % 5 === 0 ? 'Medium' : 'Low',
    context: 'Local synthetic preview persona. Not a live Contact record.',
  }))
  const types = ['Current account', 'Savings account', 'Debit card', 'Mortgage', 'ISA', 'Loan']
  const holdings: Holding[] = customers.flatMap((customer, index) => [0, 1, 2].map((offset) => {
    const product = products[(index + offset) % products.length]
    const type = types[(index + offset) % types.length]
    return {
      id: `preview-holding-${index}-${offset}`, customerId: customer.id, productId: product.id, name: product.name,
      number: `PREVIEW-HOLD-${index}-${offset}`, accountNumber: `DEMO-${index}-${offset}`, type,
      status: 'Active', balance: type === 'Debit card' ? undefined : 2100 + index * 350 + offset * 40,
      cardLastFour: type === 'Debit card' ? `${4100 + index}` : undefined,
      cardStatus: type === 'Debit card' ? 'Active' : undefined, notes: 'Synthetic preview holding; never used for live connector writes.',
    }
  }))
  const now = Date.now()
  const time = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
  const titles = ['Card replacement after a lost wallet', 'Payment query needs transaction details', 'ISA transfer clarification', 'Complaint: awaiting a service update', 'Mortgage repayment options', 'Identity review document enquiry']
  const cases: CaseItem[] = titles.map((title, index) => ({
    id: `preview-case-${index}`, number: `PREVIEW-${1000 + index}`, title,
    description: 'Synthetic case illustrating human review. Select a priority, active status and add a review note. Preview never writes Dataverse.',
    customerId: customers[index].id, holdingId: holdings.find(holding => holding.customerId === customers[index].id)?.id,
    status: index === 1 ? 'Waiting for Details' : 'In Progress', state: 0, priority: index === 0 ? 1 : 2,
    category: index === 3 ? 'Problem' : 'Question', createdAt: time(45 + index * 12), modifiedAt: time(5 + index * 3),
    owner: 'Preview service desk', statusCode: index === 1 ? 3 : 1,
  }))
  const messages: MailItem[] = titles.map((subject, index) => ({
    id: `preview-mail-${index}`, subject, from: customers[index].email, replyTo: customers[index].email, to: ENVIRONMENT.helpMailbox,
    body: `Hello Gravity Bank,\n\n${subject}. Could you explain the next steps and any details you need from me?\n\nCustomer reference: ${customers[index].customerNumber}\n\nThank you,\n${customers[index].name}`,
    receivedAt: time(3 + index * 7), hasAttachments: index % 2 === 0, isRead: index > 1, mailbox: ENVIRONMENT.helpMailbox,
    internetMessageId: `<preview-${index}@gravity.invalid>`,
  }))
  const tasks: TaskItem[] = cases.slice(0, 3).map(item => ({ id: `preview-task-${item.id}`, caseId: item.id,
    subject: 'Clarify the customer request', description: 'Preview task for the service desk.', status: 'Not Started', dueAt: new Date(now + 3600_000).toISOString() }))
  const notes: NoteItem[] = cases.slice(0, 2).map(item => ({ id: `preview-note-${item.id}`, caseId: item.id,
    subject: 'Synthetic reviewer context', body: 'Preview note: verify customer identity and obtain missing details before any action.', createdAt: time(10) }))
  return {
    customers, holdings, products, cases, messages, tasks, notes,
    workflow: { id: ENVIRONMENT.flowId, name: 'Help Shared Mailbox Workflow (preview)', active: true,
      categories: REQUEST_CLASSES.map(item => item.label), helpMailbox: ENVIRONMENT.helpMailbox,
      description: 'Local illustrative process configuration, not live execution telemetry.' },
    health: ['Contacts', 'Products', 'Financial holdings', 'Cases', 'Tasks', 'Case notes', 'Dataverse email activities', 'Help Shared Mailbox Workflow',
      `Inbox: ${ENVIRONMENT.helpMailbox}`].map(source => ({
        source, status: 'healthy', detail: 'LOCAL SYNTHETIC PREVIEW - no API request was made.',
      })),
    mode: 'preview', fetchedAt: new Date(now).toISOString(), windowStart: new Date(now - 86_400_000).toISOString(), truncated: [],
  }
}
