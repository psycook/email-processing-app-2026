export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Outlook does not reliably preserve newlines via white-space CSS.
export function emailBodyHtml(body: string): string {
  const text = body.replace(/\r\n?/g, '\n').trim()
  if (!text) return ''
  return text.split(/\n[ \t]*\n(?:[ \t]*\n)*/)
    .map(paragraph => `<p style="margin:0 0 16px;">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}
