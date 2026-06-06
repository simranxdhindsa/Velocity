import { ShieldX, Mail, RotateCcw, KanbanSquare } from 'lucide-react'

interface NoAccessPageProps {
  message?: string
  onReset: () => void
}

const isBlocked = (msg: string) => msg.toLowerCase().includes('blocked')

export default function NoAccessPage({ message = '', onReset }: NoAccessPageProps) {
  const blocked = isBlocked(message)

  const handleTryAgain = () => {
    onReset()
  }

  return (
    <div className="nap-root">
      {/* Subtle background blobs */}
      <div className="nap-blob nap-blob-1" />
      <div className="nap-blob nap-blob-2" />

      <div className="nap-card">
        {/* App wordmark */}
        <div className="nap-wordmark">
          <KanbanSquare size={18} />
          <span>Velocity</span>
        </div>

        {/* Icon */}
        <div className={`nap-icon-wrap ${blocked ? 'nap-icon-blocked' : 'nap-icon-denied'}`}>
          <ShieldX size={36} />
        </div>

        {/* Heading */}
        <h1 className="nap-heading">
          {blocked ? 'Account Blocked' : 'Access Denied'}
        </h1>

        {/* Message from server */}
        <p className="nap-message">
          {message || 'You are not authorised to access this application.'}
        </p>

        {/* Hint */}
        <div className="nap-hint">
          <Mail size={14} />
          <span>Contact your administrator to request access or resolve this issue.</span>
        </div>

        {/* Actions */}
        <div className="nap-actions">
          <button className="nap-btn-try" onClick={handleTryAgain}>
            <RotateCcw size={14} />
            Try a different account
          </button>
        </div>
      </div>
    </div>
  )
}
