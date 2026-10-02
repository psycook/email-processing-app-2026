import type { EmailDraft } from '../types'
import type { ClientSendAttachment, ClientSendHtmlMessage } from '../generated/models/Office365OutlookModel'
import { emailBodyHtml } from './emailBody.ts'

// Called only after the gateway validates the live Contact alias and attachments.
export function outlookMessage(
  draft: Pick<EmailDraft, 'from' | 'to' | 'subject' | 'body'>,
  attachments: ClientSendAttachment[],
): ClientSendHtmlMessage {
  return {
    From: draft.from,
    To: draft.to,
    Subject: draft.subject,
    Body: emailBodyHtml(draft.body),
    Attachments: attachments,
  }
}
