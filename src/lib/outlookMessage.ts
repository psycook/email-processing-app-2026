import type { EmailDraft } from '../types'
import type { ClientSendAttachment, ClientSendHtmlMessage } from '../generated/models/Office365OutlookModel'
import { emailBodyHtml } from './emailBody.ts'
import { validateDraftAddresses } from './emailDrafts.ts'

// Called only after the gateway validates the live Contact alias and attachments.
export function outlookMessage(
  draft: Pick<EmailDraft, 'from' | 'replyTo' | 'to' | 'subject' | 'body'>,
  attachments: ClientSendAttachment[],
): ClientSendHtmlMessage {
  validateDraftAddresses(draft)
  return {
    From: draft.from,
    ReplyTo: draft.replyTo,
    To: draft.to,
    Subject: draft.subject,
    Body: emailBodyHtml(draft.body),
    Attachments: attachments,
  }
}
