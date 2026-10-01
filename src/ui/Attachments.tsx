import { useState } from 'react'
import type { Attachment } from '../types'
import { downloadAttachment } from '../lib/studioEngine'
import { Modal } from './Modal'
import { IconButton, Badge } from './primitives'
import { formatBytes } from './util'
import { FileText, ImageIcon, Eye, Download, Trash2, Paperclip } from './icons'

function dataUrl(attachment: Attachment): string {
  return `data:${attachment.mimeType};base64,${attachment.contentBytes}`
}

function isImage(attachment: Attachment): boolean {
  return attachment.mimeType.startsWith('image/')
}

function isPdf(attachment: Attachment): boolean {
  return attachment.mimeType === 'application/pdf'
}

export function AttachmentList({
  attachments,
  onRemove,
  compact,
}: {
  attachments: Attachment[]
  onRemove?: (id: string) => void
  compact?: boolean
}) {
  const [preview, setPreview] = useState<Attachment | null>(null)

  if (attachments.length === 0) {
    return <p className="attach-empty">No attachments.</p>
  }

  return (
    <>
      <ul className={compact ? 'attach-list attach-list--compact' : 'attach-list'}>
        {attachments.map((attachment) => {
          const Icon = isImage(attachment) ? ImageIcon : FileText
          const previewable = isImage(attachment) || isPdf(attachment)
          return (
            <li className="attach-chip" key={attachment.id}>
              <span className="attach-chip__icon" aria-hidden="true">
                <Icon size={16} />
              </span>
              <span className="attach-chip__text">
                <span className="attach-chip__name" title={attachment.name}>
                  {attachment.name}
                </span>
                <span className="attach-chip__meta">
                  {formatBytes(attachment.size)}
                  {attachment.generated ? (
                    <Badge tone="lavender" soft>
                      Synthetic
                    </Badge>
                  ) : null}
                </span>
              </span>
              <span className="attach-chip__actions">
                {previewable ? (
                  <IconButton label={`Preview ${attachment.name}`} icon={<Eye size={15} />} onClick={() => setPreview(attachment)} />
                ) : null}
                <IconButton
                  label={`Download ${attachment.name}`}
                  icon={<Download size={15} />}
                  onClick={() => downloadAttachment(attachment)}
                />
                {onRemove ? (
                  <IconButton label={`Remove ${attachment.name}`} icon={<Trash2 size={15} />} onClick={() => onRemove(attachment.id)} />
                ) : null}
              </span>
            </li>
          )
        })}
      </ul>

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview?.name ?? 'Attachment'}
        description={preview ? `${preview.mimeType} · ${formatBytes(preview.size)}` : undefined}
        size="lg"
      >
        {preview && isImage(preview) ? (
          <img className="attach-preview-img" src={dataUrl(preview)} alt={preview.name} />
        ) : preview && isPdf(preview) ? (
          <iframe className="attach-preview-frame" title={preview.name} src={dataUrl(preview)} />
        ) : (
          <p className="attach-empty">
            <Paperclip size={15} /> No inline preview available for this file type.
          </p>
        )}
      </Modal>
    </>
  )
}
