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
