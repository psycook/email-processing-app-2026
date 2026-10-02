import type { Attachment, CostAssumptions, Customer, EmailDraft, GeneratorInput, GeneratorOutput, Holding } from '../types'
import { REQUEST_CLASSES } from '../types'
import { holdingDisplayName, holdingEmailReference } from './holdingLabels'
import { validateDraftAddresses } from './emailDrafts'
export { makeDraft } from './emailDrafts'

const MAX_ENCODED_BYTES = 4 * 1024 * 1024
const FORMATS: Record<string, { extension: RegExp; signature: (value: string) => boolean }> = {
  'application/pdf': { extension: /\.pdf$/i, signature: value => value.startsWith('%PDF-') },
  'image/png': { extension: /\.png$/i, signature: value => value.startsWith('\x89PNG\r\n\x1a\n') },
  'image/jpeg': { extension: /\.jpe?g$/i, signature: value => value.startsWith('\xff\xd8\xff') },
  'image/gif': { extension: /\.gif$/i, signature: value => /^(GIF87a|GIF89a)/.test(value) },
  'image/webp': { extension: /\.webp$/i, signature: value => value.startsWith('RIFF') && value.slice(8, 12) === 'WEBP' },
}

export function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 2 }).format(value)
}
export function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
  }).format(date) : 'Not available'
}

export function estimateCosts(a: CostAssumptions) {
  if (Object.values(a).some(value => !Number.isFinite(value) || value < 0) || a.automationRate > 1) {
    throw new Error('Cost assumptions must be finite and nonnegative; automation rate must be between zero and one.')
  }
  const weightedMinutes = a.automationRate * a.automatedMinutes + (1 - a.automationRate) * a.reviewMinutes
  const manualCost = a.monthlyVolume * a.manualMinutes * a.hourlyCost / 60
  const variableCost = weightedMinutes * a.hourlyCost / 60 + a.aiCostPerEmail + a.connectorCostPerEmail
  const automatedCost = a.monthlyVolume * variableCost + a.fixedMonthlyCost
  const monthlySavings = manualCost - automatedCost
  const unitSaving = a.manualMinutes * a.hourlyCost / 60 - variableCost
  return {
    manualCost, automatedCost, monthlySavings, annualSavings: monthlySavings * 12,
    hoursSaved: a.monthlyVolume * (a.manualMinutes - weightedMinutes) / 60,
    costPerEmail: a.monthlyVolume ? automatedCost / a.monthlyVolume : 0,
    roi: automatedCost ? monthlySavings / automatedCost : 0,
    breakEvenVolume: unitSaving > 0 ? Math.ceil(a.fixedMonthlyCost / unitSaving) : Number.POSITIVE_INFINITY,
  }
}

export function matchingHolding(holdings: Holding[], category: GeneratorInput['category']): Holding | undefined {
  const rules: Partial<Record<GeneratorInput['category'], RegExp>> = {
    'card-support': /card/i, lending: /mortgage|loan/i, 'savings-investments': /saving|isa|investment/i,
    payments: /current|credit card account/i,
  }
  return rules[category] ? holdings.find(holding => rules[category]?.test(holding.type)) : holdings[0]
}

export function generateTemplate(input: GeneratorInput): GeneratorOutput {
  if (input.holding && input.holding.customerId !== input.customer.id) throw new Error('The selected holding belongs to a different customer.')
  const { customer, holding, category, complexity, index } = input
  const holdingRef = holding ? holdingEmailReference(holding) : 'my Gravity Bank services'
  const own = holding ? `I am writing about ${holdingRef}.` : 'Please help me with a banking service enquiry.'
  const scenarios: Record<GeneratorInput['category'], { subject: string; request: string; outcome: string }> = {
    'account-servicing': { subject: 'Could you help me get a statement?', request: `Could you explain how to obtain a recent statement for ${holdingRef} through a secure channel?`, outcome: 'Identify customer; route to account servicing; verify before making changes.' },
    'card-support': { subject: holding ? "I've lost my card - what next?" : 'How do I replace a lost card?', request: holding ? `I cannot find ${holdingRef}. Please explain how to protect it and arrange a replacement. I have not authorised any account changes by this email.` : 'Please explain the card replacement process and what details you need to identify an eligible card. I have not provided a card reference.', outcome: 'Identify the card only from supplied context; prioritise card safety; do not assume identity verification.' },
    payments: { subject: 'Could you help me check a payment?', request: holding ? `A payment from ${holdingRef} needs checking. Please tell me which date and transaction reference you need to investigate.` : 'I have a payment query but have not supplied a transaction reference. What information should I provide securely?', outcome: 'Route payment enquiry; ask for missing transaction details; no transfer should be executed.' },
    lending: { subject: holding ? 'A question about my repayments' : 'Can you explain my borrowing options?', request: holding ? `Could you explain repayment options for ${holdingRef}, including any conditions or fees before I decide what to do?` : 'I would like information about Gravity Bank lending products. Please explain eligibility and next steps without assuming I already hold a loan or mortgage.', outcome: 'Route to lending servicing or product enquiry; provide information without taking a financial action.' },
    'savings-investments': { subject: holding ? 'Thinking about moving my savings' : 'Help choosing a savings account', request: holding ? `Please explain the available servicing options for ${holdingRef} and the information required before a transfer can be considered.` : 'Could you explain your savings and ISA options, and the checks required before an application or transfer?', outcome: 'Route to savings/investment support; distinguish information from an authorised transfer.' },
    complaint: { subject: "I'm still waiting for some help", request: `I am unhappy with the response to a previous enquiry about ${holdingRef}. Please record my complaint, explain the next steps, and arrange a review. I do not have the previous case reference available.`, outcome: 'Record complaint; prioritise appropriately; human review with missing prior case reference.' },
    'fraud-security': { subject: "Something on my account doesn't look right", request: `I have noticed something I do not recognise in connection with ${holdingRef}. Please tell me how to contact your fraud team securely. I have not included transaction details and do not authorise any payments or changes.`, outcome: 'Route urgently to fraud/security and human review; do not infer fraud is confirmed or execute financial actions.' },
    kyc: { subject: 'Which documents do you need from me?', request: 'Please explain which documents are required for my next identity review and the approved secure submission process. Any attached document is clearly marked synthetic test evidence, not a genuine identity document.', outcome: 'Route to KYC; request secure submission; do not mark verification complete based on a synthetic attachment.' },
  }
  const scenario = scenarios[category]
  const greetings = ['Hello Gravity Bank team,', 'Hi customer support,', 'Good morning,'][index % 3]
  const complexityText = complexity === 'multi-intent'
    ? '\n\nAlso, please explain how I can track this enquiry and receive updates through a secure channel.'
    : complexity === 'ambiguous'
      ? '\n\nI may have confused this with another recent issue. I do not have the dates or previous reference to hand, so please ask me to clarify before taking action.'
      : ''
  return {
    subject: scenario.subject,
    body: `${greetings}\n\n${own}\n\n${scenario.request}${complexityText}\n\nThank you,\n${customer.name}`,
    expectedOutcome: `${scenario.outcome}${complexity === 'ambiguous' ? ' Explicit clarification/human review is expected.' : ''}`,
  }
}

export function validateDraft(draft: EmailDraft): void {
  validateDraftAddresses(draft)
  if (!draft.body.trim() || !draft.subject.trim() || draft.subject.length > 255 || /[\r\n]/.test(draft.subject)) {
    throw new Error('Add a subject and message; the subject must be a single line under 256 characters.')
  }
  const names = new Set<string>()
  let total = 0
  for (const attachment of draft.attachments) {
    if (names.has(attachment.name.toLowerCase())) throw new Error('Attachment filenames must be unique.')
    names.add(attachment.name.toLowerCase())
    total += attachment.contentBytes.length + new TextEncoder().encode(attachment.name).byteLength + 32
  }
  if (draft.attachments.length > 20 || total > MAX_ENCODED_BYTES) throw new Error('Attach no more than 20 files or 4 MiB including base64 overhead.')
}

function base64(bytes: Uint8Array): string {
  let result = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) result += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(result)
}

export async function fileToAttachment(file: File): Promise<Attachment> {
  const format = FORMATS[file.type]
  if (!format || !format.extension.test(file.name)) throw new Error('Choose a PDF, PNG, JPEG, GIF or WebP file with a matching file extension.')
  if (file.size === 0 || Math.ceil(file.size / 3) * 4 > MAX_ENCODED_BYTES - 512) throw new Error('The file is empty or too large. The encoded attachment limit is 4 MiB.')
  if (/[\\/:*?"<>|]/.test(file.name) || Array.from(file.name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || file.name.length > 128) throw new Error('Use a safe attachment filename under 129 characters.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!format.signature(String.fromCharCode(...bytes.subarray(0, 16)))) throw new Error('File content does not match its declared document format.')
  return { id: crypto.randomUUID(), name: file.name, mimeType: file.type, size: bytes.length, contentBytes: base64(bytes), generated: false }
}

function documentLines(customer: Customer, holding?: Holding): string[] {
  return [
    'SYNTHETIC TEST DOCUMENT - NOT VALID FINANCIAL OR IDENTITY EVIDENCE',
    `Customer: ${customer.name}`, `Customer reference: ${customer.customerNumber || 'Not supplied'}`,
    `Created: ${formatDate(new Date().toISOString())}`,
    ...(holding ? [
      `Holding: ${holdingDisplayName(holding)}`,
      `Product type: ${holding.type}`, `Status: ${holding.status}`,
      ...(holding.balance === undefined ? [] : [`Fixture balance: ${formatMoney(holding.balance)}`]),
      ...(holding.cardLastFour ? [`Card ending: ${holding.cardLastFour}`] : []),
    ] : ['No specific financial holding supplied.']),
    'Purpose: exercise document extraction and customer matching in a controlled demo.',
    'This is a synthetic account-context summary, not a statement of real transactions.',
    'It grants no authority to make a payment, amend a holding, or complete identity checks.',
  ]
}

export async function createDocumentAttachment(kind: 'pdf' | 'image', customer: Customer, holding?: Holding): Promise<Attachment> {
  if (holding && holding.customerId !== customer.id) throw new Error('Generate documents only for holdings owned by the selected customer.')
  const lines = documentLines(customer, holding)
  let file: File
  if (kind === 'pdf') {
    const { jsPDF } = await import('jspdf')
    const doc = new jsPDF()
    doc.setFont('helvetica', 'bold').setFontSize(24).text('gravity bank', 20, 25)
    doc.setFontSize(10).text('Your money. Your orbit. / Evaluation evidence', 20, 34)
    doc.setDrawColor(110).line(20, 42, 190, 42)
    doc.setFont('helvetica', 'normal').setFontSize(10)
    let y = 54
    for (const line of lines) {
      const wrapped = doc.splitTextToSize(line, 165)
      doc.text(wrapped, 20, y)
      y += wrapped.length * 6 + 6
    }
    doc.setFontSize(9).text('DEMO ONLY / No genuine identity, signature or payment information', 20, 280)
    file = new File([doc.output('arraybuffer')], `gravity-context-${customer.customerNumber || customer.id.slice(0, 8)}.pdf`, { type: 'application/pdf' })
  } else {
    const canvas = document.createElement('canvas')
    canvas.width = 1400; canvas.height = 1000
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This browser cannot generate an image document.')
    const css = getComputedStyle(document.documentElement)
    ctx.fillStyle = css.getPropertyValue('--cp-surface').trim()
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = css.getPropertyValue('--cp-text').trim()
    ctx.font = 'bold 52px "Segoe UI"'; ctx.fillText('gravity bank', 70, 110)
    ctx.font = '26px "Segoe UI"'; ctx.fillText('SYNTHETIC ACCOUNT CONTEXT / DEMO ONLY', 70, 170)
    ctx.font = '23px "Segoe UI"'
    let y = 260
    for (const line of lines.slice(1)) {
      const words = line.split(' ')
      let current = ''
      for (const word of words) {
        if (ctx.measureText(`${current} ${word}`).width > 1220) { ctx.fillText(current, 70, y); y += 34; current = word }
        else current = `${current} ${word}`.trim()
      }
      ctx.fillText(current, 70, y); y += 54
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Image encoding failed.')), 'image/png'))
    file = new File([blob], `gravity-context-${customer.customerNumber || customer.id.slice(0, 8)}.png`, { type: 'image/png' })
  }
  const attachment = await fileToAttachment(file)
  const extensionIndex = attachment.name.lastIndexOf('.')
  return { ...attachment, name: `${attachment.name.slice(0, extensionIndex)}-${attachment.id.slice(0, 6)}${attachment.name.slice(extensionIndex)}`, generated: true }
}

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }))
}
export function downloadAttachment(attachment: Attachment): void {
  const decoded = atob(attachment.contentBytes)
  const bytes = new Uint8Array(decoded.length)
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i)
  downloadBlob(attachment.name, new Blob([bytes], { type: attachment.mimeType }))
}
export function requestLabel(value: GeneratorInput['category']): string {
  return REQUEST_CLASSES.find(item => item.value === value)?.label ?? value
}
