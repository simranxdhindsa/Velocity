import { ShieldX, ShieldOff, Mail, RotateCcw } from 'lucide-react'
import { VelocityLogo } from '@/components/brand/VelocityLogo'

interface NoAccessPageProps {
  message?: string
  onReset: () => void
}

const isBlocked = (msg: string) => msg.toLowerCase().includes('blocked')

export default function NoAccessPage({ message = '', onReset }: NoAccessPageProps) {
  const blocked = isBlocked(message)

  return (
    <div className="nap-root">
      <div className="nap-blob nap-blob-1" />
      <div className="nap-blob nap-blob-2" />

      <div className="nap-card">
        <div className="nap-brand">
          <VelocityLogo variant="lockup" size="sm" mark="glitch" showStatusDot={false} />
        </div>

        <div className={`nap-icon-wrap ${blocked ? 'nap-icon-blocked' : 'nap-icon-denied'}`}>
          {blocked ? <ShieldOff size={32} /> : <ShieldX size={32} />}
        </div>

        <h1 className="nap-heading">
          {blocked ? 'Account Blocked' : 'Access Denied'}
        </h1>

        <p className="nap-message">
          {message && message !== 'Failed to fetch'
            ? message
            : 'You are not authorised to access this application.'}
        </p>

        <div className="nap-hint">
          <Mail size={14} />
          <span>Contact your administrator to request access or resolve this issue.</span>
        </div>

        <div className="nap-actions">
          <button className="nap-btn-try" onClick={onReset}>
            <RotateCcw size={14} />
            Try a different account
          </button>
        </div>
      </div>
    </div>
  )
}
