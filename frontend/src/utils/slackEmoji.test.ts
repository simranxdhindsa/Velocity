import test from 'node:test'
import assert from 'node:assert/strict'
import { slackEmojify } from './slackEmoji'
import { slackPlainText, slackToMarkdown } from './slackMarkdown'
import { previewLine } from '../components/slack-chats/slack-chats-utils'
import type { SlackChat } from '../services/api'

test('turns the code from the bug report into the real emoji', () => {
  assert.equal(slackEmojify('Hey. :wave:'), 'Hey. 👋')
})

test('handles aliases, plus and minus names, and emoji side by side', () => {
  assert.equal(slackEmojify(':thumbsup: :+1:'), '👍 👍')
  assert.equal(slackEmojify(':-1:'), '👎')
  assert.equal(slackEmojify(':+1::tada:'), '👍🎉')
  assert.equal(slackEmojify(':man-shrugging:'), '🤷‍♂️')
})

test('applies skin tones, dropping the variation selector first', () => {
  assert.equal(slackEmojify(':wave::skin-tone-3:'), '👋🏼')
  assert.equal(slackEmojify(':v::skin-tone-2:'), '✌🏻')
})

test('leaves unknown codes as plain text', () => {
  assert.equal(slackEmojify(':partyparrot:'), ':partyparrot:')
  assert.equal(slackEmojify(':partyparrot::skin-tone-2:'), ':partyparrot::skin-tone-2:')
})

test('does not touch text that only looks like a code', () => {
  assert.equal(slackEmojify('meeting at 10:30:45'), 'meeting at 10:30:45')
  assert.equal(slackEmojify('a:smile:b'), 'a:smile:b')
  assert.equal(slackEmojify('https://x.com/:smile:'), 'https://x.com/:smile:')
  assert.equal(slackEmojify(':WAVE:'), ':WAVE:')
  assert.equal(slackEmojify(''), '')
})

test('common emoji all resolve to something other than their code', () => {
  for (const code of ['smile', 'fire', 'rocket', 'white_check_mark', 'eyes', 'pray', 'warning', 'x', '100']) {
    assert.notEqual(slackEmojify(`:${code}:`), `:${code}:`, code)
  }
})

test('message rendering converts emoji and keeps the other formatting', () => {
  assert.equal(slackToMarkdown('Hey. :wave:'), 'Hey. 👋')
  assert.equal(slackToMarkdown('*bold* :fire:'), '**bold** 🔥')
})

test('message rendering leaves code exactly as written', () => {
  assert.equal(slackToMarkdown('`:wave:` is code'), '`:wave:` is code')
  assert.equal(slackToMarkdown('```\n:wave:\n```'), '```\n:wave:\n```')
  assert.equal(slackToMarkdown(':wave: `:wave:` :wave:'), '👋 `:wave:` 👋')
})

test('message rendering leaves link addresses alone', () => {
  assert.equal(slackToMarkdown('see <https://x.com/a:smile:b|link>'), 'see [link](https://x.com/a:smile:b)')
})

test('plain text previews show the emoji', () => {
  assert.equal(slackPlainText('Hey. :wave:'), 'Hey. 👋')
})

test('the Chats list preview shows the emoji with its speaker label', () => {
  const chat = { last_preview: 'Hey. :wave:', last_kind: 'auto_reply' } as SlackChat
  assert.equal(previewLine(chat), 'Velocity: Hey. 👋')
})
