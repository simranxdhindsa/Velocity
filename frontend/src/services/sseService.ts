// Shared SSE singleton — one EventSource connection for the entire app.
// All consumers subscribe here instead of opening their own connections.
// Eliminates the 3x duplicate connections from useYouTrackEvents, useNotifications,
// and VelocityDataContext.

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080/api'
const DOWN_THRESHOLD = 4

type Listener = (e: MessageEvent) => void

class SSEService {
  private es: EventSource | null = null
  private refCount = 0
  private errorCount = 0
  private wasDown = false
  private registeredTypes = new Set<string>()
  private listeners = new Map<string, Set<Listener>>()

  subscribe(eventType: string, listener: Listener): () => void {
    if (!this.listeners.has(eventType)) this.listeners.set(eventType, new Set())
    this.listeners.get(eventType)!.add(listener)
    this.refCount++
    this.ensureConnection(eventType)

    return () => {
      this.listeners.get(eventType)?.delete(listener)
      this.refCount--
      if (this.refCount === 0) this.teardown()
    }
  }

  private ensureConnection(eventType: string) {
    if (!this.es) {
      this.es = new EventSource(`${API_URL}/events`)

      this.es.onopen = () => {
        if (this.wasDown) {
          window.location.reload()
          return
        }
        this.errorCount = 0
      }

      this.es.onerror = () => {
        this.errorCount++
        if (this.errorCount >= DOWN_THRESHOLD) this.wasDown = true
      }
    }

    if (!this.registeredTypes.has(eventType)) {
      this.registeredTypes.add(eventType)
      this.es.addEventListener(eventType, (e: MessageEvent) => {
        this.listeners.get(eventType)?.forEach(fn => fn(e))
      })
    }
  }

  private teardown() {
    this.es?.close()
    this.es = null
    this.registeredTypes.clear()
    this.errorCount = 0
    this.wasDown = false
  }
}

export const sseService = new SSEService()
