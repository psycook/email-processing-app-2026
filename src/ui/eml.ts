import type { EmailDraft } from '../types'
import { emailBodyHtml } from '../lib/emailBody.ts'

function wrapBase64(value: string): string {
  return value.replace(/.{76}/g, '$&\r\n')
}

// Builds a standards-ish RFC 822 / MIME message so an exported draft can be
// opened in a mail client. No network is involved — this is pure text.
export function draftToEml(draft: EmailDraft): string {
  const date = new Date(draft.sentAt ?? Date.now()).toUTCString()
  const headerLines = [
    `From: ${draft.from}`,
    `To: ${draft.to}`,
    `Subject: ${draft.subject}`,
    `Date: ${date}`,
    'MIME-Version: 1.0',
    `X-Gravity-Category: ${draft.category}`,
    `X-Gravity-Complexity: ${draft.complexity}`,
    `X-Gravity-Source: ${draft.source}`,
  ]

  const safeId = draft.id.replace(/[^a-z0-9]/gi, '')
  const alternative = `=_gravity_alt_${safeId}`
  const bodyParts = [
    `--${alternative}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    draft.body.replace(/\r\n?|\n/g, '\r\n'),
    `--${alternative}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    emailBodyHtml(draft.body),
    `--${alternative}--`,
    '',
  ]
  const bodyType = `Content-Type: multipart/alternative; boundary="${alternative}"`

  if (draft.attachments.length === 0) {
    return [...headerLines, bodyType, '', ...bodyParts].join('\r\n')
  }

  const boundary = `=_gravity_${safeId}`
  const parts: string[] = []
  parts.push(`--${boundary}`)
  parts.push(bodyType)
  parts.push('')
  parts.push(...bodyParts)
  for (const attachment of draft.attachments) {
    parts.push(`--${boundary}`)
    parts.push(`Content-Type: ${attachment.mimeType}; name="${attachment.name}"`)
    parts.push('Content-Transfer-Encoding: base64')
    parts.push(`Content-Disposition: attachment; filename="${attachment.name}"`)
    parts.push('')
    parts.push(wrapBase64(attachment.contentBytes))
  }
  parts.push(`--${boundary}--`)
  parts.push('')

  return [...headerLines, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n')
}

export function emlFilename(draft: EmailDraft): string {
  const safe = (draft.subject || 'draft').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'draft'
  return `${safe}.eml`
}
