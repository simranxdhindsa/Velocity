import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import '../styles/components/issue-detail-skeleton.css'
import { setSkeletonActive } from './issue-detail-handoff'

const DESC_WIDTHS = ['idp-sk-w-100', 'idp-sk-w-90', 'idp-sk-w-75', 'idp-sk-w-100', 'idp-sk-w-60', 'idp-sk-w-90', 'idp-sk-w-45']
const SIDEBAR_LABELS = ['idp-sk-w-30', 'idp-sk-w-40', 'idp-sk-w-30', 'idp-sk-w-55', 'idp-sk-w-40', 'idp-sk-w-30', 'idp-sk-w-45']

interface IssueDetailSkeletonProps {
  onClose: () => void
  /** Ticket id shown in the top bar while loading, if known */
  idReadable?: string
}

/** Shown in the same modal shell as IssueDetailPanel while the ticket is being fetched. */
export function IssueDetailSkeleton({ onClose, idReadable }: IssueDetailSkeletonProps) {
  useEffect(() => {
    setSkeletonActive(true)
    return () => setSkeletonActive(false)
  }, [])

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="idp-modal idp-modal--loading" onClick={e => e.stopPropagation()}>
        <div className="idp-topbar">
          <div className="idp-topbar-left">
            {idReadable
              ? <span className="idp-issue-id">{idReadable}</span>
              : <div className="skeleton idp-sk-id" />}
            <div className="skeleton idp-sk-chip" />
          </div>
          <div className="idp-topbar-actions">
            <div className="skeleton idp-sk-btn" />
            <button className="idp-close" onClick={onClose}><X size={16} /></button>
          </div>
        </div>

        <div className="idp-body">
          <div className="idp-main">
            <div className="skeleton idp-sk-title idp-sk-w-90" />
            <div className="skeleton idp-sk-line idp-sk-w-60" />
            <div className="idp-section">
              <div className="skeleton idp-sk-line idp-sk-w-30" />
              {DESC_WIDTHS.map((w, i) => (
                <div key={i} className={`skeleton idp-sk-line ${w}`} />
              ))}
            </div>
            <div className="idp-section">
              <div className="skeleton idp-sk-line idp-sk-w-30" />
              <div className="skeleton idp-sk-line idp-sk-w-75" />
              <div className="skeleton idp-sk-line idp-sk-w-55" />
            </div>
          </div>

          <div className="idp-sidebar">
            {SIDEBAR_LABELS.map((w, i) => (
              <div key={i} className="idp-meta-row">
                <div className={`skeleton idp-sk-line ${w}`} />
                <div className="skeleton idp-sk-value" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
