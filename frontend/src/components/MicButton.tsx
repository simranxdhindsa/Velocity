import { useState, useRef } from 'react'

const TRANSCRIBE_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8080/api') + '/daytrack/transcribe'

interface MicButtonProps {
  onResult: (text: string) => void
  onError?: (msg: string) => void
  className?: string
}

async function transcribeBlob(blob: Blob): Promise<string> {
  const token = localStorage.getItem('token')
  const fd = new FormData()
  fd.append('audio', blob, 'recording.webm')
  const res = await fetch(TRANSCRIBE_URL, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  })
  if (!res.ok) throw new Error(`Transcription failed: ${res.status}`)
  const data = await res.json()
  return data.text ?? ''
}

export default function MicButton({ onResult, onError, className = '' }: MicButtonProps) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const mrRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startTimeRef = useRef<number>(0)

  function startBrowserFallback() {
    const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition
    if (!SR) { onError?.('Microphone not available'); return }
    const rec = new SR()
    rec.lang = 'en-IN'
    rec.continuous = false
    rec.interimResults = false
    rec.onresult = (e: any) => { onResult(e.results[0][0].transcript); setState('idle') }
    rec.onerror = () => { onError?.('Could not recognise speech'); setState('idle') }
    rec.onend = () => setState('idle')
    setState('recording')
    rec.start()
  }

  async function toggle() {
    if (state === 'transcribing') return
    if (state === 'recording') { mrRef.current?.stop(); return }

    if (!navigator.mediaDevices?.getUserMedia) { startBrowserFallback(); return }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg'
      const mr = new MediaRecorder(stream, { mimeType })
      chunksRef.current = []
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const duration = Date.now() - startTimeRef.current
        if (duration < 400) {
          onError?.('Recording too short — please hold and speak, then tap to stop')
          setState('idle')
          return
        }
        setState('transcribing')
        const blob = new Blob(chunksRef.current, { type: mr.mimeType })
        try {
          const text = await transcribeBlob(blob)
          if (text) onResult(text.trim())
          else onError?.('No speech detected — please try again')
        } catch (err) {
          const msg = err instanceof Error ? err.message : ''
          if (msg.includes('400') || msg.includes('empty') || msg.includes('no audio')) {
            onError?.('No audio detected — please try again')
          } else {
            onError?.('Transcription failed — please try again')
          }
        }
        setState('idle')
      }
      mr.start()
      startTimeRef.current = Date.now()
      mrRef.current = mr
      setState('recording')
    } catch {
      startBrowserFallback()
    }
  }

  const recClass = state === 'recording' ? ' mic-btn--rec' : state === 'transcribing' ? ' mic-btn--loading' : ''

  return (
    <button
      type="button"
      className={`mic-btn${recClass}${className ? ' ' + className : ''}`}
      onClick={toggle}
      disabled={state === 'transcribing'}
      title={
        state === 'idle' ? 'Click to record, click again to stop'
        : state === 'recording' ? 'Recording… click to stop'
        : 'Transcribing…'
      }
    >
      {state === 'transcribing' ? (
        <svg className="mic-spin" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        </svg>
      ) : state === 'recording' ? (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <rect x="6" y="6" width="12" height="12" rx="1.5"/>
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      )}
    </button>
  )
}
