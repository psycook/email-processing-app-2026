import type { RequestClass } from '../types'
import { REQUEST_CLASSES } from '../types'

export interface StageMeta {
  id: string
  label: string
  short: string
  summary: string
  dataSource: string
  config: string
  action: string
  instrumented: boolean
}

// Process design (configuration facts, not runtime telemetry).
export const PIPELINE_STAGES: StageMeta[] = [
  {
    id: 'mailbox',
    label: 'Mailbox',
    short: 'Intake',
    summary: 'Inbound customer email lands in the monitored help mailbox and is picked up for processing.',
    dataSource: 'Office 365 Outlook · help mailbox',
    config: 'Trigger on new message in the configured shared mailbox.',
    action: 'Office365Outlook · On new email',
    instrumented: true,
  },
  {
    id: 'identify',
    label: 'Identify customer',
    short: 'Match',
    summary: 'The sender address is matched to a known contact to attach customer, KYC and holding context.',
    dataSource: 'Dataverse · contacts',
    config: 'Lookup contact by email; fall back to unmatched handling.',
    action: 'Contacts · list / get',
    instrumented: false,
  },
  {
    id: 'classify',
    label: 'Classify',
    short: 'Classify',
    summary: 'The message intent is categorised so it can be routed to the right queue or handler.',
    dataSource: 'Help workflow · agentnode classifier',
    config: 'Map message to a request category and complexity.',
    action: 'Help workflow · Classify_Email / InvokeDefinition',
    instrumented: false,
  },
  {
    id: 'route',
    label: 'Route',
    short: 'Route',
    summary: 'A case is created or updated and routed to the appropriate owner or team.',
    dataSource: 'Dataverse · incidents',
    config: 'Create case, set category, owner and priority.',
    action: 'Incidents · create / update',
    instrumented: false,
  },
  {
    id: 'act',
    label: 'Act',
    short: 'Act',
    summary: 'Automated handling drafts a reply or performs the servicing action where permitted.',
    dataSource: 'Office 365 Outlook · reply',
    config: 'Draft response, attach notes and tasks.',
    action: 'Office365Outlook · reply / Tasks · create',
    instrumented: false,
  },
  {
    id: 'review',
    label: 'Human review',
    short: 'Review',
    summary: 'Cases that need a person are held open for an agent to check, edit and resolve.',
    dataSource: 'Dataverse · incidents (open)',
    config: 'Surface open cases; capture notes and status.',
    action: 'Incidents · list open',
    instrumented: true,
  },
]

export interface Option {
  value: number
  label: string
}

// Active-only status codes. These are presented for in-flight cases and must
// match the parent Dataverse adapter's statusCode mapping.
export const REVIEW_STATUS_OPTIONS: Option[] = [
  { value: 1, label: 'In progress' },
  { value: 2, label: 'On hold' },
  { value: 3, label: 'Waiting for details' },
  { value: 4, label: 'Researching' },
]

// Dynamics incident prioritycode: 1 High, 2 Normal, 3 Low.
export const PRIORITY_OPTIONS: Option[] = [
  { value: 1, label: 'High' },
  { value: 2, label: 'Normal' },
  { value: 3, label: 'Low' },
]

export function priorityLabel(priority: number): string {
  return PRIORITY_OPTIONS.find((option) => option.value === priority)?.label ?? 'Normal'
}

export function priorityTone(priority: number): 'danger' | 'warning' | 'neutral' {
  if (priority === 1) return 'danger'
  if (priority === 3) return 'neutral'
  return 'warning'
}

export function classLabel(value: RequestClass): string {
  return REQUEST_CLASSES.find((item) => item.value === value)?.label ?? value
}

export const COMPLEXITY_OPTIONS: { value: 'simple' | 'multi-intent' | 'ambiguous'; label: string; hint: string }[] = [
  { value: 'simple', label: 'Simple', hint: 'Single, clearly stated request' },
  { value: 'multi-intent', label: 'Multi-intent', hint: 'Several asks in one message' },
  { value: 'ambiguous', label: 'Ambiguous', hint: 'Unclear intent needing judgement' },
]
