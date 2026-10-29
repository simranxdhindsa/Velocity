import { NotificationItem } from './NotificationItem'
import type { Notification } from '../../services/api'
import { QuantumOrbitLoader } from '../brand/VelocityLoaders'
import { VelocityLogo } from '../brand/VelocityLogo'

interface NotificationPanelProps {
  notifications: Notification[]
  loading: boolean
  onMarkAsRead: (id: string) => void
  onMarkAllAsRead: () => void
  onClose: () => void
}

export function NotificationPanel({
  notifications,
  loading,
  onMarkAsRead,
  onMarkAllAsRead,
  onClose,
}: NotificationPanelProps) {
  const unreadCount = notifications.filter(n => !n.read).length

  return (
    <div className="notification-panel glass-card">
      <div className="notification-panel-header">
        <h3>Notifications</h3>
        {unreadCount > 0 && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={onMarkAllAsRead}
          >
            Mark all as read
          </button>
        )}
      </div>

      <div className="notification-panel-content">
        {loading ? (
          <div className="notification-loading">
            <QuantumOrbitLoader size={40} />
            <p>Loading notifications...</p>
          </div>
        ) : notifications.length > 0 ? (
          <div className="notification-list">
            {notifications.map(notification => (
              <NotificationItem
                key={notification.id}
                notification={notification}
                onMarkAsRead={onMarkAsRead}
              />
            ))}
          </div>
        ) : (
          <div className="notification-empty">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px' }}>
              <VelocityLogo variant="icon" size="md" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
            </div>
            <p>No notifications</p>
          </div>
        )}
      </div>

      <div className="notification-panel-footer">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
