import DOMPurify from 'dompurify'

// Tags/attributes that could script, track, or exfiltrate are dropped entirely.
// Images are removed wholesale so remote tracking pixels can never load.
const FORBID_TAGS = [
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
  'form', 'input', 'button', 'textarea', 'img', 'svg', 'video', 'audio', 'source', 'picture',
]
const FORBID_ATTR = [
  'style', 'srcset', 'background', 'onerror', 'onload', 'onclick', 'onmouseover', 'ping', 'formaction',
]

let hooksInstalled = false
function ensureHooks() {
  if (hooksInstalled) return
  hooksInstalled = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer nofollow')
    }
  })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const HTML_PATTERN = /<([a-z]+)(\s[^>]*)?>|<\/[a-z]+>|&[a-z]+;|&#\d+;/i

export function looksLikeHtml(body: string): boolean {
  return HTML_PATTERN.test(body)
}

export interface RenderedBody {
  html: string
  isHtml: boolean
  imagesStripped: boolean
}

// Produces a safe HTML string for dangerouslySetInnerHTML. Plain text is escaped
// and line breaks preserved; HTML is sanitised with scripts and images removed.
export function renderEmailBody(body: string): RenderedBody {
  const source = body ?? ''
  const isHtml = looksLikeHtml(source)
  const imagesStripped = /<img[\s>]/i.test(source)
  if (!isHtml) {
    return { html: escapeHtml(source).replace(/\r?\n/g, '<br />'), isHtml: false, imagesStripped: false }
  }
  ensureHooks()
  const clean = DOMPurify.sanitize(source, {
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
  })
  return { html: clean, isHtml: true, imagesStripped }
}

// Plain-text single-line preview for list rows (tags removed, whitespace collapsed).
export function plainPreview(body: string, maxLength = 140): string {
  const text = (body ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}
