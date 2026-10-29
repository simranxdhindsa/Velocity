import { createPortal } from 'react-dom'
import { AlertTriangle, Trash2, AlertCircle, X } from 'lucide-react'

export type ConfirmVariant = 'danger' | 'warning' | 'info'

export interface ConfirmModalProps {
  /** Controls visibility — renders nothing when false */
  open?: boolean
  /** Bold heading above the message */
  title?: string
  message: string
  /** Smaller muted subtext below message */
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Controls icon + confirm button colour. Default: 'danger' */
  variant?: ConfirmVariant
  onConfirm: () => void
  onCancel: () => void
}

const ICONS: Record<ConfirmVariant, React.ReactNode> = {
  danger:  <Trash2 size={22} />,
  warning: <AlertTriangle size={22} />,
  info:    <AlertCircle size={22} />,
}

/**
 * Global portal-based confirmation modal. Replaces all browser confirm() calls.
 *
 * Two usage patterns:
 *
 * 1. Controlled via `open` prop (mount/unmount the component):
 *    <ConfirmModal open={showDelete} message="…" onConfirm={del} onCancel={close} />
 *
 * 2. Conditional render (simpler, no open prop needed):
 *    {showDelete && <ConfirmModal message="…" onConfirm={del} onCancel={() => setShowDelete(false)} />}
 */
export function ConfirmModal({
  open = true,
  title,
  message,
  detail,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  if (!open) return null

  return createPortal(
    <div className="cm-overlay" onClick={onCancel}>
      <div className="cm-box" onClick={e => e.stopPropagation()}>
        <button className="cm-close" onClick={onCancel}><X size={15} /></button>

        <div className={`confirm-modal-icon confirm-modal-icon--${variant}`}>
          {ICONS[variant]}
        </div>

        {title && <h3 className="confirm-modal-title">{title}</h3>}
        <p className="cm-message">{message}</p>
        {detail && <p className="cm-detail">{detail}</p>}

        <div className="confirm-modal-actions">
          <button className="confirm-modal-btn confirm-modal-btn--cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={`confirm-modal-btn confirm-modal-btn--${variant}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
