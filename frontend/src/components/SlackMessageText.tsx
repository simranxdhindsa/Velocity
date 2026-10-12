import { useMemo } from 'react'
import { renderSlackMessage } from '@/utils/slackMarkdown'
import '@/styles/components/slack-message-text.css'

// Renders a Slack message body the way Slack shows it: Markdown tables as
// real tables (Velocity sends them as native Slack table blocks), *bold* and
// **bold**, _italic_, ~strike~, `code`, code blocks, lists, links, and
// <@U123> mentions as @Name. Used wherever Velocity shows a message it sent
// or queued (Claude Queue, Slack Messages hub).

export function SlackMessageText({ text, userMap, className }: {
  text: string
  userMap?: Map<string, string>
  className?: string
}) {
  const html = useMemo(() => renderSlackMessage(text, userMap), [text, userMap])
  return <div className={`smt-body${className ? ` ${className}` : ''}`} dangerouslySetInnerHTML={{ __html: html }} />
}
