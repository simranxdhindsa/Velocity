import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Slack message text → safe HTML, shared by SlackMessageText. Kept out of
// the component file so React fast refresh works.

/** Slack mrkdwn → Markdown that marked understands, mentions resolved. */
export function slackToMarkdown(text: string, userMap?: Map<string, string>): string {
  const fences: string[] = []
  // Leave code blocks untouched while rewriting everything else.
  let s = text.replace(/```[\s\S]*?```/g, m => `⟦F${fences.push(m) - 1}⟧`)

  s = s
    // <@U123> / <@U123|name> → @Name (escaped, styled as a mention)
    .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id: string, label?: string) => {
      const name = userMap?.get(id) || label || id
      return `<span class="smt-mention">@${escapeHtml(name)}</span>`
    })
    // <#C123|channel> → #channel
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    // <!here> / <!channel> → @here
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    // <url|label> → [label](url), <url> → url
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '[$2]($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    // Slack's single-asterisk *bold* → **bold** (Markdown would italicise it)
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, '$1**$2**')
    // Slack's single-tilde ~strike~ → ~~strike~~
    .replace(/(^|[^~\w])~(?=\S)([^~\n]+?)(?<=\S)~(?![~\w])/g, '$1~~$2~~')

  return s.replace(/⟦F(\d+)⟧/g, (_, i: string) => fences[Number(i)])
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

/** Markdown → sanitized HTML. Links open in a new tab. */
export function renderSlackMessage(text: string, userMap?: Map<string, string>): string {
  const html = marked.parse(slackToMarkdown(text, userMap), { gfm: true, breaks: true, async: false }) as string
  const clean = DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] })
  // Wide tables scroll inside their own box instead of stretching the card.
  return clean
    .replace(/<table>/g, '<div class="smt-table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>')
    .replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ')
}

/**
 * One-line plain text for short snippets and search (cut-off previews where
 * rendering half a table would look broken): mentions and links resolved,
 * Markdown markers (*, _, ~, `) removed, table rows flattened to
 * "a · b · c" with separator rows dropped, whitespace collapsed.
 */
export function slackPlainText(text: string, userMap?: Map<string, string>): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id: string, label?: string) => `@${userMap?.get(id) || label || 'user'}`)
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<#C[A-Z0-9]+>/g, '#channel')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<https?:[^>]+>/g, '[link]')
    .split('\n')
    .filter(line => !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) // table separator rows
    .map(line => /^\s*\|.*\|\s*$/.test(line)
      ? line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()).filter(Boolean).join(' · ')
      : line)
    .join(' ')
    .replace(/```/g, '')
    .replace(/(\*\*|__|~~|[*_~`])(?=\S)([^*_~`]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
}
