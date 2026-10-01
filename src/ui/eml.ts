import type { EmailDraft } from '../types'

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

  if (draft.attachments.length === 0) {
    return [...headerLines, 'Content-Type: text/plain; charset=utf-8', '', draft.body].join('\r\n')
  }

  const boundary = `=_gravity_${draft.id.replace(/[^a-z0-9]/gi, '')}`
  const parts: string[] = []
  parts.push(`--${boundary}`)
  parts.push('Content-Type: text/plain; charset=utf-8')
  parts.push('Content-Transfer-Encoding: 8bit')
  parts.push('')
  parts.push(draft.body)
  for (const attachment of draft.attachments) {
    parts.push(`--${boundary}`)
    parts.push(`Content-Type: ${attachment.mimeType}; name="${attachment.name}"`)
    parts.push('Content-Transfer-Encoding: base64')
    parts.push(`Content-Disposition: attachment; filename="${attachment.name}"`)
    parts.push('')
    parts.push(wrapBase64(attachment.contentBytes))
  }
  parts.push(`--${boundary}--`)

  return [...headerLines, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n')
}

export function emlFilename(draft: EmailDraft): string {
  const safe = (draft.subject || 'draft').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'draft'
  return `${safe}.eml`
}
