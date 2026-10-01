import type { IOperationResult } from '@microsoft/power-apps/data'
import type { IGetAllOptions } from '../generated/models/CommonModels'
import type { Contacts } from '../generated/models/ContactsModel'
import { Contactsrfd_kycriskrating, Contactsrfd_kycstatus } from '../generated/models/ContactsModel'
import type { Products } from '../generated/models/ProductsModel'
import { Productsstatecode } from '../generated/models/ProductsModel'
import type { Rfd_financialaccounts } from '../generated/models/Rfd_financialaccountsModel'
import {
  Rfd_financialaccountsrfd_cardstatus,
  Rfd_financialaccountsrfd_lifecyclestatus,
  Rfd_financialaccountsrfd_producttype,
  Rfd_financialaccountsstatecode,
} from '../generated/models/Rfd_financialaccountsModel'
import type { Incidents } from '../generated/models/IncidentsModel'
import {
  Incidentscasetypecode,
  Incidentsprioritycode,
  Incidentsstatecode,
  Incidentsstatuscode,
} from '../generated/models/IncidentsModel'
import type { Tasks } from '../generated/models/TasksModel'
import { Tasksstatuscode } from '../generated/models/TasksModel'
import type { Annotations, AnnotationsBase } from '../generated/models/AnnotationsModel'
import type { Workflows } from '../generated/models/WorkflowsModel'
import { Workflowscategory, Workflowsstatecode } from '../generated/models/WorkflowsModel'
import type { GraphClientReceiveMessage, ClientSendHtmlMessage } from '../generated/models/Office365OutlookModel'
import { ContactsService } from '../generated/services/ContactsService'
import { ProductsService } from '../generated/services/ProductsService'
import { Rfd_financialaccountsService } from '../generated/services/Rfd_financialaccountsService'
import { IncidentsService } from '../generated/services/IncidentsService'
import { TasksService } from '../generated/services/TasksService'
import { AnnotationsService } from '../generated/services/AnnotationsService'
import { EmailsService } from '../generated/services/EmailsService'
import { WorkflowsService } from '../generated/services/WorkflowsService'
import { Office365OutlookService } from '../generated/services/Office365OutlookService'
import { AgentsService } from '../generated/services/AgentsService'
import { runInlineAgent } from './inlineAgent'
import { generationMessage } from '../lib/emailGeneration'
import { ENVIRONMENT, REQUEST_CLASSES } from '../types'
import type {
  Attachment, CaseItem, Customer, EmailDraft, GeneratorInput, GeneratorOutput, Holding,
  MailItem, NoteItem, Product, ReviewChange, SourceHealth, StudioSettings, StudioSnapshot,
  TaskItem, WorkflowInfo,
} from '../types'

const REFERENCE_TTL = 60_000
const DYNAMIC_TTL = 10_000
const DAY = 86_400_000
const MAILBOX_LIMIT = 250
const ATTACHMENT_LIMIT = 4 * 1024 * 1024
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Loaded<T> { data: T; detail: string; truncated: string[]; count?: number }
interface SourceResult<T> extends Loaded<T> { health: SourceHealth }
interface SourceCache<T> {
  source: string
  ttl: number
  empty: T
  value?: Loaded<T>
  result?: SourceResult<T>
  fetchedAt?: number
  attemptedAt?: number
  pending?: Promise<SourceResult<T>>
}

function cache<T>(source: string, ttl: number, empty: T): SourceCache<T> {
  return { source, ttl, empty }
}

const contactsCache = cache<Customer[]>('Contacts', REFERENCE_TTL, [])
const productsCache = cache<Product[]>('Products', REFERENCE_TTL, [])
const holdingsCache = cache<Holding[]>('Financial holdings', REFERENCE_TTL, [])
const casesCache = cache<CaseItem[]>('Cases', DYNAMIC_TTL, [])
const tasksCache = cache<TaskItem[]>('Tasks', DYNAMIC_TTL, [])
const notesCache = cache<NoteItem[]>('Case notes', DYNAMIC_TTL, [])
const emailsCache = cache<number>('Dataverse email activities', DYNAMIC_TTL, 0)
const workflowCache = cache<WorkflowInfo | undefined>('Help Shared Mailbox Workflow', REFERENCE_TTL, undefined)
const helpCache = cache<MailItem[]>(`Inbox: ${ENVIRONMENT.helpMailbox}`, DYNAMIC_TTL, [])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rawField(row: unknown, name: string): unknown {
  return isRecord(row) ? row[name] : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function lookup(row: unknown, name: string, projected?: string): string {
  return text(rawField(row, name)) || text(projected)
}

function formatted(row: unknown, name: string): string {
  return text(rawField(row, `${name}@OData.Community.Display.V1.FormattedValue`))
}

function choice(choices: Readonly<Record<number, string>>, value: number | undefined): string {
  if (value === undefined || value === null) return 'Not set'
  return choices[value] ?? `Unknown (${value})`
}

function requireId(value: string, source: string): string {
  if (typeof value !== 'string' || !GUID.test(value)) throw new Error(`${source}: missing or invalid record ID.`)
  return value
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message
  if (isRecord(error) && typeof error.message === 'string') return error.message
  return typeof error === 'string' ? error : 'An unspecified connector error occurred.'
}

function operationData<T>(result: IOperationResult<T>, source: string): T {
  if (!result.success) throw new Error(`${source}: ${result.error ? errorDetail(result.error) : 'operation failed without an error detail.'}`)
  if (result.data === undefined || result.data === null) throw new Error(`${source}: successful operation returned no data.`)
  return result.data
}

function requireLive(settings: StudioSettings): void {
  if (settings.mode !== 'live') throw new Error('Live connector operations are disabled in preview mode.')
  if (settings.helpMailbox !== ENVIRONMENT.helpMailbox || settings.senderMailbox !== ENVIRONMENT.senderMailbox) {
    throw new Error('Monitoring and sender-alias configuration must match the approved Help Inbox and outbound alias pool.')
  }
}

async function readSource<T>(entry: SourceCache<T>, load: () => Promise<Loaded<T>>): Promise<SourceResult<T>> {
  if (entry.pending) return entry.pending
  if (entry.result && entry.attemptedAt !== undefined && Date.now() - entry.attemptedAt < entry.ttl) return entry.result
  entry.attemptedAt = Date.now()
  const pending = (async (): Promise<SourceResult<T>> => {
    try {
      const value = await load()
      entry.value = value
      entry.fetchedAt = Date.now()
      entry.result = {
        ...value,
        health: { source: entry.source, status: 'healthy', detail: `${value.detail} Read at ${new Date(entry.fetchedAt).toISOString()}.`, count: value.count },
      }
    } catch (error) {
      const detail = errorDetail(error)
      const previous = entry.value
      const stale = previous && entry.fetchedAt !== undefined
        ? `Stale data retained from ${new Date(entry.fetchedAt).toISOString()}.`
        : 'No successful data available; empty display is not a confirmed zero count.'
      const unavailable = /not initialized|not configured|not supported|unsupported|connection.*(missing|not found)|data source.*not found|access denied|permission|unavailable/i.test(detail)
      entry.result = {
        data: previous ? previous.data : entry.empty,
        detail: `${detail} ${stale}`,
        count: previous?.count,
        truncated: [...(previous?.truncated ?? []), `${entry.source}: ${stale} Counts are incomplete or stale.`],
        health: { source: entry.source, status: unavailable ? 'unavailable' : 'error', detail: `${detail} ${stale}`, count: previous?.count },
      }
    }
    return entry.result
  })()
  entry.pending = pending
  try {
    return await pending
  } finally {
    if (entry.pending === pending) entry.pending = undefined
  }
}

async function readRows<T>(
  source: string,
  getAll: (options?: IGetAllOptions) => Promise<IOperationResult<T[]>>,
  options: IGetAllOptions,
  cap: number,
): Promise<Loaded<T[]>> {
  const rows: T[] = []
  let skipToken: string | undefined
  let count: number | undefined
  const tokens = new Set<string>()
  do {
    const result = await getAll({ ...options, count: true, maxPageSize: Math.min(1000, cap - rows.length), skipToken })
    const page = operationData(result, source)
    if (!Array.isArray(page)) throw new Error(`${source}: expected a record array.`)
    if (count === undefined && typeof result.count === 'number') count = result.count
    rows.push(...page.slice(0, cap - rows.length))
    skipToken = result.skipToken
    if (skipToken) {
      if (tokens.has(skipToken)) throw new Error(`${source}: connector repeated its continuation token; completeness cannot be verified.`)
      tokens.add(skipToken)
    }
    if (page.length === 0 && skipToken) {
      throw new Error(`${source}: empty page has a continuation token; completeness cannot be verified.`)
    }
  } while (skipToken && rows.length < cap)
  const capped = Boolean(skipToken) || rows.length >= cap || (count !== undefined && count > rows.length)
  return {
    data: rows,
    count: rows.length,
    detail: `${rows.length} records loaded${count === undefined ? '; server total unavailable' : `; server match count ${count}${count >= 5000 ? ' (Dataverse count ceiling)' : ''}`}.`,
    truncated: capped ? [`${source}: capped at ${cap} loaded records; dashboard counts are a sample, not a complete total.`] : [],
  }
}

function converted<T, U>(loaded: Loaded<T[]>, convert: (row: T) => U, scope: string): Loaded<U[]> {
  return { ...loaded, data: loaded.data.map(convert), detail: `${scope} ${loaded.detail}` }
}

function customer(row: Contacts): Customer {
  return {
    id: requireId(row.contactid, 'Contacts'),
    name: [text(row.firstname), text(row.lastname)].filter(Boolean).join(' '),
    email: text(row.emailaddress1).trim().toLowerCase(),
    customerNumber: text(row.rfd_customernumber),
    accountNumber: text(row.rfd_demoaccountnumber),
    kyc: choice(Contactsrfd_kycstatus, row.rfd_kycstatus),
    risk: choice(Contactsrfd_kycriskrating, row.rfd_kycriskrating),
    context: text(row.description),
  }
}

function product(row: Products): Product {
  return {
    id: requireId(row.productid, 'Products'), name: text(row.name), number: text(row.productnumber),
    description: text(row.description), state: choice(Productsstatecode, row.statecode),
  }
}

function holding(row: Rfd_financialaccounts): Holding {
  return {
    id: requireId(row.rfd_financialaccountid, 'Financial holdings'),
    customerId: lookup(row, '_rfd_customerid_value', row.rfd_customerid),
    productId: lookup(row, '_rfd_productid_value'),
    name: text(row.rfd_name), number: text(row.rfd_holdingnumber), accountNumber: text(row.rfd_accountnumber),
    type: choice(Rfd_financialaccountsrfd_producttype, row.rfd_producttype),
    status: row.rfd_lifecyclestatus !== undefined
      ? choice(Rfd_financialaccountsrfd_lifecyclestatus, row.rfd_lifecyclestatus)
      : choice(Rfd_financialaccountsstatecode, row.statecode),
    balance: typeof row.rfd_currentbalance === 'number' ? row.rfd_currentbalance : undefined,
    cardLastFour: row.rfd_cardlastfour, cardStatus: choice(Rfd_financialaccountsrfd_cardstatus, row.rfd_cardstatus),
    notes: text(row.rfd_servicingnotes),
  }
}

function caseItem(row: Incidents): CaseItem {
  if (!(row.statecode in Incidentsstatecode)) throw new Error('Cases: missing or unsupported case state.')
  return {
    id: requireId(row.incidentid, 'Cases'), number: text(row.ticketnumber), title: text(row.title),
    description: text(row.description), customerId: lookup(row, '_customerid_value', row.customerid),
    holdingId: lookup(row, '_rfd_financialaccountid_value') || undefined,
    status: row.statuscode === undefined ? choice(Incidentsstatecode, row.statecode) : choice(Incidentsstatuscode, row.statuscode),
    state: row.statecode, priority: row.prioritycode ?? 0,
    category: choice(Incidentscasetypecode, row.casetypecode),
    createdAt: text(row.createdon), modifiedAt: text(row.modifiedon), statusCode: row.statuscode ?? 0,
    owner: formatted(row, '_ownerid_value') || lookup(row, '_ownerid_value', row.ownerid) || 'Unassigned',
  }
}

function task(row: Tasks): TaskItem {
  return {
    id: requireId(row.activityid, 'Tasks'), subject: text(row.subject), description: text(row.description),
    caseId: lookup(row, '_regardingobjectid_value'), status: choice(Tasksstatuscode, row.statuscode), dueAt: row.scheduledend,
  }
}

function note(row: Annotations): NoteItem {
  return {
    id: requireId(row.annotationid, 'Case notes'), subject: text(row.subject), body: text(row.notetext),
    caseId: lookup(row, '_objectid_value'), createdAt: text(row.createdon), filename: row.filename,
  }
}

function mail(row: GraphClientReceiveMessage, mailbox: string): MailItem {
  if (!row.id) throw new Error(`${mailbox}: an email has no connector message ID.`)
  if (!row.receivedDateTime || !Number.isFinite(Date.parse(row.receivedDateTime))) {
    throw new Error(`${mailbox}: an email has no valid receivedDateTime; the rolling window cannot be established.`)
  }
  return {
    id: row.id, subject: text(row.subject), from: text(row.from), to: text(row.toRecipients),
    receivedAt: row.receivedDateTime, body: text(row.body) || text(row.bodyPreview),
    hasAttachments: row.hasAttachments === true, isRead: row.isRead === true,
    mailbox, internetMessageId: row.internetMessageId,
  }
}

async function readMailbox(mailbox: string): Promise<Loaded<MailItem[]>> {
  const result = await Office365OutlookService.GetEmailsV3(
    'Inbox', undefined, undefined, undefined, undefined, 'Any', false, undefined, false, false,
    mailbox, false, undefined, MAILBOX_LIMIT,
  )
  const response = operationData(result, mailbox)
  if (!Array.isArray(response.value)) throw new Error(`${mailbox}: connector returned no message array.`)
  const rows = response.value.map(row => mail(row, mailbox))
  return {
    data: rows, count: rows.length,
    detail: `Inbox-only connector sample of up to ${MAILBOX_LIMIT} messages; attachments excluded. Rolling 24-hour counts are filtered locally by receivedDateTime, not whole-mailbox throughput.`,
    truncated: rows.length >= MAILBOX_LIMIT
      ? [`${mailbox}: Inbox sample reached the ${MAILBOX_LIMIT}-message cap; additional messages may be omitted because GetEmailsV3 has no continuation input/output.`]
      : [],
  }
}

function workflowInfo(row: Workflows): WorkflowInfo {
  if (!(row.statecode in Workflowsstatecode)) throw new Error('Workflow returned an unsupported state.')
  if (!row.clientdata) throw new Error('Workflow clientdata unavailable; trigger mailbox cannot be verified.')
  const parsed: unknown = JSON.parse(row.clientdata)
  const definition = rawField(rawField(parsed, 'properties'), 'definition')
  const triggers = rawField(definition, 'triggers')
  if (!isRecord(triggers)) throw new Error('Workflow trigger definition is unavailable.')
  const sharedTrigger = Object.values(triggers).find(trigger =>
    rawField(rawField(rawField(trigger, 'inputs'), 'host'), 'operationId') === 'SharedMailboxOnNewEmailV2',
  )
  const mailbox = text(rawField(rawField(rawField(sharedTrigger, 'inputs'), 'parameters'), 'mailboxAddress'))
  if (mailbox.toLowerCase() !== ENVIRONMENT.helpMailbox) throw new Error('Workflow trigger mailbox differs from the configured Help mailbox.')
  const classifier = findNamedRecord(rawField(definition, 'actions'), 'Classify_Email')
  const inlineDefinition = rawField(rawField(rawField(classifier, 'inputs'), 'parameters'), 'body/definition')
  const output = rawField(rawField(rawField(rawField(inlineDefinition, 'entity'), 'configuration'), 'agentSettings'), 'output')
  const schemaText = text(rawField(output, 'schema'))
  const schema: unknown = schemaText ? JSON.parse(schemaText) : undefined
  const categories = rawField(rawField(rawField(schema, 'properties'), 'predictedCategory'), 'enum')
  return {
    id: requireId(row.workflowid, 'Workflow'), name: text(row.name),
    active: row.statecode === 1,
    categories: Array.isArray(categories) ? categories.filter((value): value is string => typeof value === 'string') : [],
    helpMailbox: mailbox,
    description: `${text(row.description)} ${choice(Workflowscategory, row.category)}; ${choice(Workflowsstatecode, row.statecode)}. No flow run history or execution metrics are available from this record.`.trim(),
  }
}

function findNamedRecord(value: unknown, name: string): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    const direct = value[name]
    if (isRecord(direct)) return direct
    for (const child of Object.values(value)) {
      const found = findNamedRecord(child, name)
      if (found) return found
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const found = findNamedRecord(child, name)
      if (found) return found
    }
  }
  return undefined
}

export async function fetchSnapshot(settings: StudioSettings): Promise<StudioSnapshot> {
  requireLive(settings)
  const startedAt = new Date()
  const windowStart = new Date(startedAt.getTime() - DAY).toISOString()
  const recentStart = new Date(startedAt.getTime() - 7 * DAY).toISOString()
  const [customers, products, holdings, cases, tasks, notes, emailActivities, workflow, helpInbox] = await Promise.all([
    readSource(contactsCache, async () => converted(await readRows('Contacts', ContactsService.getAll, {
      select: ['contactid', 'firstname', 'lastname', 'emailaddress1', 'rfd_customernumber', 'rfd_demoaccountnumber', 'rfd_kycstatus', 'rfd_kycriskrating', 'description'],
      orderBy: ['contactid asc'],
    }, 5000), customer, 'All contacts, up to 5000; reference cache 60 seconds.')),
    readSource(productsCache, async () => converted(await readRows('Products', ProductsService.getAll, {
      select: ['productid', 'name', 'productnumber', 'description', 'statecode'], orderBy: ['productid asc'],
    }, 5000), product, 'All product states; reference cache 60 seconds.')),
    readSource(holdingsCache, async () => converted(await readRows('Financial holdings', Rfd_financialaccountsService.getAll, {
      select: ['rfd_financialaccountid', '_rfd_customerid_value', '_rfd_productid_value', 'rfd_name', 'rfd_holdingnumber', 'rfd_accountnumber', 'rfd_producttype', 'rfd_lifecyclestatus', 'statecode', 'rfd_currentbalance', 'rfd_cardlastfour', 'rfd_cardstatus', 'rfd_servicingnotes'],
      orderBy: ['rfd_financialaccountid asc'],
    }, 5000), holding, 'All holdings, including historical/inactive records, up to 5000; reference cache 60 seconds.')),
    readSource(casesCache, async () => converted(await readRows('Cases', IncidentsService.getAll, {
      select: ['incidentid', 'ticketnumber', 'title', 'description', '_customerid_value', '_rfd_financialaccountid_value', 'statecode', 'statuscode', 'prioritycode', 'casetypecode', 'createdon', 'modifiedon', '_ownerid_value'],
      filter: `statecode eq 0 or modifiedon ge ${recentStart}`, orderBy: ['modifiedon desc', 'incidentid asc'],
    }, 1000), caseItem, `Active cases plus cases modified since ${recentStart}; up to 1000. Counts describe loaded records, not all-time totals.`)),
    readSource(tasksCache, async () => converted(await readRows('Tasks', TasksService.getAll, {
      select: ['activityid', 'subject', 'description', '_regardingobjectid_value', 'statuscode', 'scheduledend'],
      filter: `statecode eq 0 or modifiedon ge ${recentStart}`, orderBy: ['modifiedon desc', 'activityid asc'],
    }, 1000), task, `Open tasks plus tasks modified since ${recentStart}; regarding IDs are retained without assuming every task belongs to a case.`)),
    readSource(notesCache, async () => converted(await readRows('Case notes', AnnotationsService.getAll, {
      select: ['annotationid', 'subject', 'notetext', '_objectid_value', 'createdon', 'filename'],
      filter: `objecttypecode eq 'incident' and createdon ge ${recentStart}`, orderBy: ['createdon desc', 'annotationid asc'],
    }, 1000), note, `Case notes created since ${recentStart}; file bodies are not downloaded.`)),
    readSource(emailsCache, async () => {
      const result = await readRows('Dataverse email activities', EmailsService.getAll, {
        select: ['activityid', 'createdon'], filter: `createdon ge ${recentStart}`, orderBy: ['createdon desc', 'activityid asc'],
      }, 1000)
      return { ...result, data: result.data.length, detail: `Dataverse email activities created since ${recentStart}; not Inbox messages or delivery proof. ${result.detail}` }
    }),
    readSource(workflowCache, async () => {
      const row = operationData(await WorkflowsService.get(ENVIRONMENT.flowId, {
        select: ['workflowid', 'name', 'description', 'statecode', 'category', 'clientdata'],
      }), 'Workflow')
      const info = workflowInfo(row)
      return { data: info, count: 1, truncated: [], detail: `${info.name}; ${info.active ? 'Activated' : choice(Workflowsstatecode, row.statecode)}. Trigger mailbox verified from clientdata. Run counts and timings are not exposed.` }
    }),
    readSource(helpCache, () => readMailbox(ENVIRONMENT.helpMailbox)),
  ])
  const recentMessages = (rows: MailItem[]): MailItem[] => rows.filter(row => {
    const providedDate = Date.parse(row.receivedAt)
    return providedDate >= startedAt.getTime() - DAY && providedDate <= startedAt.getTime()
  })
  const helpMessages = recentMessages(helpInbox.data)
  const mailboxHealth = (result: SourceResult<MailItem[]>, count: number): SourceHealth => ({
    ...result.health,
    count: result.health.count === undefined ? undefined : count,
    detail: `${result.health.detail} ${count} loaded messages within ${windowStart}–${startedAt.toISOString()}.`,
  })
  return {
    customers: customers.data, products: products.data, holdings: holdings.data, cases: cases.data,
    tasks: tasks.data, notes: notes.data, workflow: workflow.data,
    messages: helpMessages.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)),
    health: [customers.health, products.health, holdings.health, cases.health, tasks.health, notes.health, emailActivities.health, workflow.health, mailboxHealth(helpInbox, helpMessages.length)],
    fetchedAt: new Date().toISOString(), windowStart, mode: 'live',
    truncated: [customers, products, holdings, cases, tasks, notes, emailActivities, workflow, helpInbox].flatMap(source => source.truncated),
  }
}

function safeAlias(value: string): boolean {
  const suffix = `@${ENVIRONMENT.domain}`
  return value === value.toLowerCase() && value.endsWith(suffix)
    && /^[a-z]+(?:[._-][a-z]+)*$/.test(value.slice(0, -suffix.length))
    && value !== ENVIRONMENT.helpMailbox && value !== ENVIRONMENT.senderMailbox
}

function htmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function attachmentBytes(attachment: Attachment): string {
  if (!attachment.name || attachment.name.length > 128 || /[\\/:*?"<>|]/.test(attachment.name) || hasControlCharacters(attachment.name)) {
    throw new Error('Attachment filenames must be safe names without paths or control characters.')
  }
  const formats: Readonly<Record<string, RegExp>> = {
    'application/pdf': /\.pdf$/i, 'image/png': /\.png$/i, 'image/jpeg': /\.jpe?g$/i,
    'image/gif': /\.gif$/i, 'image/webp': /\.webp$/i,
  }
  if (!formats[attachment.mimeType]?.test(attachment.name)) throw new Error('Only PDF, PNG, JPEG, GIF and WebP attachments with matching filenames are supported.')
  const encoded = attachment.contentBytes
  if (!encoded || encoded.length > ATTACHMENT_LIMIT || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('Attachment content must be bounded, canonical base64, not a data URL.')
  }
  const decoded = atob(encoded)
  if (btoa(decoded) !== encoded || !Number.isSafeInteger(attachment.size) || attachment.size <= 0 || attachment.size !== decoded.length) {
    throw new Error('Attachment size or base64 content is inconsistent.')
  }
  const hasSignature = attachment.mimeType === 'application/pdf' ? decoded.startsWith('%PDF-')
    : attachment.mimeType === 'image/png' ? decoded.startsWith('\x89PNG\r\n\x1a\n')
      : attachment.mimeType === 'image/jpeg' ? decoded.startsWith('\xff\xd8\xff')
        : attachment.mimeType === 'image/gif' ? /^(GIF87a|GIF89a)/.test(decoded)
          : decoded.startsWith('RIFF') && decoded.slice(8, 12) === 'WEBP'
  if (!hasSignature) throw new Error('Attachment bytes do not match the declared PDF/image format.')
  return encoded
}

export async function sendEmail(draft: EmailDraft, settings: StudioSettings): Promise<void> {
  requireLive(settings)
  if (!settings.aliasSendingConfirmed) {
    throw new Error('Alias-sending capability is unverified. Manually verify the received From header for this connector and the demo customer aliases before enabling sends; SendEmailV2 may canonicalize aliases.')
  }
  if (draft.to !== ENVIRONMENT.helpMailbox || !safeAlias(draft.from)) {
    throw new Error('Sending is restricted to a lowercase Contact alias in the demo domain, addressed only to the Help mailbox.')
  }
  if (!draft.body.trim() || draft.body.length > 100_000 || !draft.subject.trim() || draft.subject.length > 255 || hasControlCharacters(draft.subject)) {
    throw new Error('A nonempty body and a safe subject are required (body ≤100,000 characters; subject ≤255).')
  }
  if (draft.state === 'sent' || draft.state === 'unknown' || draft.state === 'cancelled') {
    throw new Error('This draft cannot be sent; sent/unknown outcomes require reconciliation and must not be retried.')
  }
  if (draft.attachments.length > 20) throw new Error('A maximum of 20 PDF/image attachments is supported.')
  let encodedTotal = 0
  let decodedTotal = 0
  const names = new Set<string>()
  const attachments = draft.attachments.map(attachment => {
    if (names.has(attachment.name.toLowerCase())) throw new Error('Attachment filenames must be unique.')
    names.add(attachment.name.toLowerCase())
    encodedTotal += attachment.contentBytes.length + new TextEncoder().encode(attachment.name).byteLength + 32
    decodedTotal += attachment.size
    if (encodedTotal > ATTACHMENT_LIMIT || decodedTotal > ATTACHMENT_LIMIT) {
      throw new Error('Total attachments must not exceed 4 MiB, including base64 encoding, filenames and attachment metadata.')
    }
    return { Name: attachment.name, ContentBytes: attachmentBytes(attachment) }
  })
  const contact = operationData(await ContactsService.get(requireId(draft.customerId, 'Sender Contact'), {
    select: ['contactid', 'emailaddress1', 'statecode'],
  }), 'Sender Contact')
  const alias = text(contact.emailaddress1).trim().toLowerCase()
  if (requireId(contact.contactid, 'Sender Contact').toLowerCase() !== draft.customerId.toLowerCase()
    || contact.statecode !== 0 || !safeAlias(alias) || draft.from !== alias) {
    throw new Error('From must exactly match the selected active Contact’s live demo alias; the primary mailbox is never substituted.')
  }
  const message: ClientSendHtmlMessage = {
    From: alias, To: ENVIRONMENT.helpMailbox, Subject: draft.subject,
    Body: `<div style="white-space:pre-wrap">${htmlText(draft.body)}</div>`, Attachments: attachments,
  }
  // A connector error is not a non-delivery receipt; errors after submission are
  // deliberately held for reconciliation. Never auto-retry this non-idempotent operation.
  try {
    const result = await Office365OutlookService.SendEmailV2(message)
    if (!result.success) throw new Error(result.error ? errorDetail(result.error) : 'Connector returned failure without an error detail.')
  } catch (error) {
    throw new Error(`SendEmailV2 outcome is unknown: ${errorDetail(error)} Do not automatically retry; inspect the sender/Help mailboxes and reconcile. This operation supplies no message ID or delivery confirmation.`)
  }
}

type ActiveStatus = Extract<Incidentsstatuscode, 1 | 2 | 3 | 4>
function activeStatus(value: number): value is ActiveStatus {
  return (value === 1 || value === 2 || value === 3 || value === 4) && value in Incidentsstatuscode
}
function priority(value: number): value is Incidentsprioritycode {
  return (value === 1 || value === 2 || value === 3) && value in Incidentsprioritycode
}

type NoteWrite = Pick<AnnotationsBase, 'subject' | 'notetext' | 'isdocument'> & { 'objectid_incident@odata.bind': string }

export async function saveCaseReview(caseId: string, change: ReviewChange): Promise<void> {
  requireId(caseId, 'Case review')
  if (!priority(change.priority) || !activeStatus(change.statusCode)) {
    throw new Error('Review supports priorities 1 High/2 Normal/3 Low and active statuses 1 In Progress/2 On Hold/3 Waiting for Details/4 Researching only. Resolution/cancellation requires a separate supported API.')
  }
  if (!change.note.trim() || change.note.length > 100_000) throw new Error('A nonempty human review note of up to 100,000 characters is required.')
  const existing = operationData(await IncidentsService.get(caseId, {
    select: ['incidentid', 'statecode', 'statuscode', '_ownerid_value'],
  }), 'Fresh case review read')
  if (requireId(existing.incidentid, 'Fresh case review read').toLowerCase() !== caseId.toLowerCase()) {
    throw new Error('Fresh case read returned a different case; no review changes were written.')
  }
  if (existing.statecode !== 0 || existing.statuscode === undefined || !activeStatus(existing.statuscode)) {
    throw new Error('The case is no longer active with a supported active status; no review changes were written.')
  }
  const noteWrite: NoteWrite = {
    subject: 'Gravity Studio human review', isdocument: false,
    notetext: `${change.note.trim()}\n\nPriority: ${Incidentsprioritycode[change.priority]}; status: ${Incidentsstatuscode[change.statusCode]}.`,
    'objectid_incident@odata.bind': `/incidents(${caseId})`,
  }
  // Generated required owner projections are not writable scalar lookups. The SDK uses JSON.stringify:
  // toJSON emits only real note fields and the case navigation binding, leaving ownership to Dataverse.
  const generatedNote: Omit<AnnotationsBase, 'annotationid'> & { toJSON: () => NoteWrite } = {
    ...noteWrite,
    ownerid: lookup(existing, '_ownerid_value', existing.ownerid),
    owneridtype: text(rawField(existing, '_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname')) || text(existing.owneridtype),
    toJSON: () => noteWrite,
  }
  try {
    const updated = await IncidentsService.update(caseId, { prioritycode: change.priority, statuscode: change.statusCode })
    if (!updated.success) throw new Error(updated.error ? errorDetail(updated.error) : 'Connector reported failure.')
  } catch (error) {
    casesCache.attemptedAt = undefined
    throw new Error(`Case review update failed or its outcome is unknown: ${errorDetail(error)} No note was attempted; refresh before retrying.`)
  }
  casesCache.attemptedAt = undefined
  notesCache.attemptedAt = undefined
  try {
    const created = await AnnotationsService.create(generatedNote)
    if (!created.success) throw new Error(created.error ? errorDetail(created.error) : 'Connector reported failure.')
  } catch (error) {
    throw new Error(`Partial review: case priority/status were updated, but the review note failed or its outcome is unknown: ${errorDetail(error)} Refresh and inspect case notes before retrying; there is no transaction or automatic rollback.`)
  }
}

const OUTPUT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { subject: { type: 'string' }, body: { type: 'string' }, expectedOutcome: { type: 'string' } },
  required: ['subject', 'body', 'expectedOutcome'],
  additionalProperties: false,
})

function generatorDefinition(schemaName = 'workflow_gravitystudio_generation') {
  // Shape/model grounded in Classify_Email's inline definition; independently authored, with every
  // tool, connection, knowledge, flow and connected-agent collection empty. Never invoke the classifier.
  return {
    components: [], environmentVariables: [], flows: [], dataverseTableSearchs: [],
    dataverseTableSearchGlossaryConfigurations: [], dataverseTableSearchEntityConfigurations: [],
    dataverseTableSearchEntityColumnSynonyms: [], connectionReferences: [], connectorDefinitions: [],
    aIModelDefinitions: [], aIPluginOperations: [], connectedAgentDefinitions: [],
    componentCollections: [], connectedBots: [], diagnostics: [],
    entity: {
      authorizedSecurityGroupIds: [], supportedLanguages: [], diagnostics: [], schemaName,
      language: 1033, accessControlPolicy: 'Any', authenticationMode: 'Integrated', authenticationTrigger: 'Always',
      synchronizationStatus: {
        graphDriveItems: [], diagnostics: [],
        lastPublishedDetails: { diagnosticDetails: [], diagnostics: [], authenticationMode: 'Integrated', $kind: 'SuccessfulPublishResultDetails' },
        $kind: 'BotSynchronizationDetails',
      },
      configuration: {
        categories: [], channels: [], settings: {}, memoryParameters: [], diagnostics: [],
        recognizer: { diagnostics: [], $kind: 'CLICopilotRecognizer' },
        agentSettings: {
          conversationStarters: [], diagnostics: [],
          model: { diagnostics: [], series: 'GPT56Reasoning', $kind: 'ModelConfig' },
          instructions: { segments: [], diagnostics: [], $kind: 'Instructions' },
          output: { diagnostics: [], schema: OUTPUT_SCHEMA, $kind: 'StructuredAgentOutput' },
          $kind: 'AgentSettings',
        },
        $kind: 'BotConfiguration',
      },
      $kind: 'BotEntity',
    },
    $kind: 'BotDefinition',
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value: unknown, index: number) => sameJson(value, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
  }
  return false
}

function safeDefinition(value: string): ReturnType<typeof generatorDefinition> {
  if (!value.trim()) return generatorDefinition()
  if (value.length > 50_000) throw new Error('Generation definition exceeds the safe 50,000-character limit.')
  const parsed: unknown = JSON.parse(value)
  const name = text(rawField(rawField(parsed, 'entity'), 'schemaName'))
  if (!/^workflow_gravitystudio_[a-z_]{1,64}$/.test(name)) {
    throw new Error('Generation definition must use an independent workflow_gravitystudio_ schema name, not a production agent.')
  }
  const safe = generatorDefinition(name)
  if (!sameJson(parsed, safe)) {
    throw new Error('Generation definition rejected: only the grounded generation-only BotDefinition schema is supported, with empty tools/actions/knowledge/connections, GPT56Reasoning, and the exact subject/body/expectedOutcome output schema. Only schemaName may vary.')
  }
  return safe
}

function generationOutput(value: unknown): GeneratorOutput {
  if (!isRecord(value) || Object.keys(value).length !== 3
    || typeof value.subject !== 'string' || typeof value.body !== 'string' || typeof value.expectedOutcome !== 'string'
    || !value.subject.trim() || !value.body.trim() || !value.expectedOutcome.trim()
    || value.subject.length > 255 || hasControlCharacters(value.subject)
    || value.body.length > 100_000 || value.expectedOutcome.length > 5000) {
    throw new Error('Agent output did not match the strict, nonempty subject/body/expectedOutcome JSON contract; no template or classifier result was substituted.')
  }
  return { subject: value.subject, body: value.body, expectedOutcome: value.expectedOutcome }
}

function parseGenerationMessage(value: string): unknown {
  const trimmed = value.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return JSON.parse(fenced ? fenced[1] : trimmed)
}

export async function generateAI(input: GeneratorInput, settings: StudioSettings): Promise<GeneratorOutput> {
  requireLive(settings)
  if (!REQUEST_CLASSES.some(item => item.value === input.category)
    || !['simple', 'multi-intent', 'ambiguous'].includes(input.complexity)
    || !Number.isSafeInteger(input.index) || input.index < 0) {
    throw new Error('Generation requires a supported request class, complexity and nonnegative integer seed index.')
  }
  if (input.holding && input.holding.customerId !== input.customer.id) throw new Error('The supplied holding does not belong to the supplied customer.')
  const definition = safeDefinition(settings.generationDefinition)
  const message = generationMessage(input)
  const result = await runInlineAgent({
    invoke: () => AgentsService.InvokeDefinition({ definition, message, locale: 'en-GB' }),
    getConversation: id => AgentsService.GetAgentConversation(id),
  })
  if (result.structuredOutput !== undefined) return generationOutput(result.structuredOutput)
  const responseText = text(result.message) || text(rawField(result, 'result'))
  if (!responseText) throw new Error('The AI conversation finished without a usable email draft.')
  const parsed: unknown = parseGenerationMessage(responseText)
  return generationOutput(parsed)
}
