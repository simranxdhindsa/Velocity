import { useCallback, useState } from 'react'

/**
 * Splits pasted text into trimmed, non-empty lines. 2+ lines is what triggers
 * the split-vs-keep-as-one prompt in usePasteSplit.
 */
export function parsePasteLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean)
}

export interface PasteSplitPending {
  lines: string[]
  anchorRect: DOMRect
  /** What the input's value would become on a normal single-line paste (lines joined with a space). */
  joinedValue: string
}

/**
 * Drop-in paste handler for single-line text inputs: pasting 2+ lines
 * intercepts the default paste and surfaces a pending split, instead of the
 * lines silently collapsing into one line. Render <PasteSplitPrompt> when
 * pasteSplitPending is set.
 */
export function usePasteSplit() {
  const [pasteSplitPending, setPasteSplitPending] = useState<PasteSplitPending | null>(null)

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text/plain')
    const lines = parsePasteLines(text)
    if (lines.length < 2) return // let the browser handle a normal paste

    e.preventDefault()
    const target = e.currentTarget
    const start = target.selectionStart ?? target.value.length
    const end = target.selectionEnd ?? target.value.length
    const joinedValue = target.value.slice(0, start) + lines.join(' ') + target.value.slice(end)
    setPasteSplitPending({ lines, anchorRect: target.getBoundingClientRect(), joinedValue })
  }, [])

  const dismiss = useCallback(() => setPasteSplitPending(null), [])

  return { pasteSplitPending, handlePaste, dismiss }
}
