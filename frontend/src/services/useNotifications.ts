import { useState, useEffect, useCallback, useRef } from 'react'
import api from './api'
import type { NotificationItem } from './api'
import { sseService } from './sseService'

/**
 * React hook for real-time notifications via SSE + REST API.
 * Provides notifications list, unread count, and actions.
 */
export function useNotifications() {
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const eventSourceRef = useRef<EventSource | null>(null)

  // Fetch notifications from API
  const fetchNotifications = useCallback(async () => {
    try {
      const response = await api.getNotifications(50)
      if (response.success && response.data) {
        setNotifications(response.data)
      }
    } catch {
      // Silently fail — notifications are non-critical
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch unread count
  const fetchUnreadCount = useCallback(async () => {
    try {
      const response = await api.getUnreadNotificationCount()
      if (response.success && response.data) {
        setUnreadCount(response.data.count)
      }
    } catch {
      // Silently fail
    }
  }, [])

  // Mark single notification as read
  const markAsRead = useCallback(async (notifId: string) => {
    try {
      await api.markNotificationAsRead(notifId)
      setNotifications(prev => prev.map(n => n.id === notifId ? { ...n, read: true } : n))
      setUnreadCount(prev => Math.max(0, prev - 1))
    } catch {
      // Silently fail
    }
  }, [])

  // Mark all as read
  const markAllAsRead = useCallback(async () => {
    try {
      await api.markAllNotificationsAsRead()
      setNotifications(prev => prev.map(n => ({ ...n, read: true })))
      setUnreadCount(0)
    } catch {
      // Silently fail
    }
  }, [])

  // Delete a notification
  const deleteNotification = useCallback(async (notifId: string) => {
    try {
      await api.deleteNotification(notifId)
      setNotifications(prev => {
        const notif = prev.find(n => n.id === notifId)
        if (notif && !notif.read) {
          setUnreadCount(c => Math.max(0, c - 1))
        }
        return prev.filter(n => n.id !== notifId)
      })
    } catch {
      // Silently fail
    }
  }, [])

  // Listen for SSE notification events
  useEffect(() => {
    fetchNotifications()
    fetchUnreadCount()

    const unsubscribe = sseService.subscribe('notification_new', (e: MessageEvent) => {
      try {
        const notif: NotificationItem = JSON.parse(e.data)
        setNotifications(prev => [notif, ...prev])
        setUnreadCount(prev => prev + 1)
      } catch {
        // Ignore malformed events
      }
    })

    return () => {
      unsubscribe()
      eventSourceRef.current = null
    }
  }, [fetchNotifications, fetchUnreadCount])

  return {
    notifications,
    unreadCount,
    loading,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    refresh: fetchNotifications,
  }
}
