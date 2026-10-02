import { emailBodyHtml } from '../lib/emailBody'

export function OutgoingEmailBody({ body }: { body: string }) {
  return <div className="outgoing-email-body" dangerouslySetInnerHTML={{ __html: emailBodyHtml(body) }} />
}
