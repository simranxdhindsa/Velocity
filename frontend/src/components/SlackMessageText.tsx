import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { renderSlackMessage } from '@/utils/slackMarkdown'
import '@/styles/components/slack-message-text.css'

// Renders a Slack message body the way Slack shows it: Markdown tables as
// real tables (Velocity sends them as native Slack table blocks), *bold* and
// **bold**, _italic_, ~strike~, `code`, code blocks, lists, links, and
// <@U123> mentions as @Name. Used wherever Velocity shows a message it sent
// or queued (Claude Queue, Slack Messages hub).

// compact: for card previews (Slack inbox, notifications). Same formatting,
// capped at about three lines with a fade instead of growing the card.
export function SlackMessageText({ text, userMap, className, compact, onClick }: {
  text: string
  userMap?: Map<string, string>
  className?: string
  compact?: boolean
  onClick?: () => void
}) {
  const html = useMemo(() => renderSlackMessage(text, userMap), [text, userMap])
  const ref = useRef<HTMLDivElement>(null)
  // Fade only when a compact preview is actually cut off, so short messages
  // don't get a dimmed last line.
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (compact && el) setClipped(el.scrollHeight > el.clientHeight + 1)
  }, [compact, html])
  const cls = ['smt-body', compact ? 'smt-compact' : '', clipped ? 'smt-clipped' : '', className ?? ''].filter(Boolean).join(' ')
  return <div ref={ref} className={cls} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}
