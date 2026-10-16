import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { tokenizeJson } from '@/utils/json'
import '@/styles/components/json-block.css'

// Pretty-printed, syntax-coloured JSON (logged tool output, API payloads).
// Starts collapsed to a few lines with a "Show all" toggle when longer, so
// a full ticket payload doesn't take over a log list.

export const JsonBlock = memo(function JsonBlock({ value }: { value: object }) {
  const tokens = useMemo(() => tokenizeJson(JSON.stringify(value, null, 2)), [value])
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const ref = useRef<HTMLPreElement>(null)

  // Only offer the toggle when the collapsed block actually cuts content off.
  useLayoutEffect(() => {
    const el = ref.current
    if (el && !open) setOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [tokens, open])

  return (
    <div className="jb">
      <pre ref={ref} className={`jb-pre${open ? '' : ' jb-pre--collapsed'}${!open && overflows ? ' jb-pre--faded' : ''}`}>
        {tokens.map((t, i) => (t.kind === 'punct' ? t.text : (
          <span key={i} className={`jb-${t.kind}`}>
            {/* Line breaks inside text values read better as real breaks than as \n */}
            {t.kind === 'string' ? t.text.replace(/\\n/g, '\n') : t.text}
          </span>
        )))}
      </pre>
      {(overflows || open) && (
        <button className="jb-toggle" onClick={() => setOpen(o => !o)}>
          {open ? <><ChevronUp size={13} />Show less</> : <><ChevronDown size={13} />Show all</>}
        </button>
      )}
    </div>
  )
})
