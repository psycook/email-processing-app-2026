import type { CaseItem, EmailDraft, MailItem, StudioSnapshot } from '../types'

export interface EvaluationEvidence {
  method: 'legacy-token' | 'candidate' | 'manual'
  inbox: MailItem[]
  cases: CaseItem[]
}

export function evaluationEvidence(draft: EmailDraft, snapshot: StudioSnapshot, helpMailbox: string): EvaluationEvidence {
  const empty: EvaluationEvidence = { method: 'manual', inbox: [], cases: [] }
  if (snapshot.mode === 'preview' || !['sent', 'unknown'].includes(draft.state)) return empty
  const token = draft.subject.match(/\[GB-STUDIO:[^\]]+\]/)?.[0]
  const fromSender = (item: MailItem) => item.mailbox.toLowerCase() === helpMailbox.toLowerCase()
    && item.from.trim().toLowerCase() === draft.from.trim().toLowerCase()
  if (token) return {
    method: 'legacy-token',
    inbox: snapshot.messages.filter(item => fromSender(item) && item.subject.includes(token)),
    cases: snapshot.cases.filter(item => item.customerId === draft.customerId
      && (item.title.includes(token) || item.description.includes(token)
        || snapshot.notes.some(note => note.caseId === item.id && note.body.includes(token)))),
  }
  const acceptedAt = Date.parse(draft.sentAt ?? '')
  if (!Number.isFinite(acceptedAt)) return empty
  // SendEmailV2 has no message ID. These bounded matches are leads, never proof of correlation.
  const nearSubmission = (value: string) => {
    const time = Date.parse(value)
    return time >= acceptedAt - 60_000 && time <= acceptedAt + 15 * 60_000
  }
  return {
    method: 'candidate',
    inbox: snapshot.messages.filter(item => fromSender(item)
      && item.subject === draft.subject && nearSubmission(item.receivedAt)),
    cases: snapshot.cases.filter(item => item.customerId === draft.customerId
      && item.title === draft.subject && nearSubmission(item.createdAt)),
  }
}
