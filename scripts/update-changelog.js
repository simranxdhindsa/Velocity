#!/usr/bin/env node
/**
 * Reads a commit message and inserts a bullet into CHANGELOG.md under the
 * correct date + section. Called by scripts/hooks/commit-msg.
 *
 * Usage: node update-changelog.js <commit-msg-file> <changelog-path>
 */

const fs = require('fs')

const msgFile      = process.argv[2]
const changelogPath = process.argv[3]

if (!msgFile || !changelogPath) {
  process.stderr.write('Usage: update-changelog.js <msg-file> <changelog-path>\n')
  process.exit(1)
}

const msg = fs.readFileSync(msgFile, 'utf8').split('\n')[0].trim()

const SECTION_MAP = {
  'FEATURE':     'Features',
  'ENHANCEMENT': 'Enhancements',
  'STYLE':       'Enhancements',
  'BUG':         'Bug Fixes',
  'REFACTOR':    'Refactors',
}

const match = msg.match(/^(FEATURE|ENHANCEMENT|STYLE|BUG|REFACTOR):\s*(.+)/)
if (!match) process.exit(0) // CHORE: and others — skip

const [, prefix, text] = match
const section = SECTION_MAP[prefix]
const entry   = `- ${text.trim()}`
const today   = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

// Read existing changelog or start fresh
let content = '# Changelog\n'
try { content = fs.readFileSync(changelogPath, 'utf8') } catch {}

const lines  = content.split('\n')
const result = []
let i = 0

const dateLine     = `## ${today}`
const sectionLine  = `### ${section}`

let dateFound    = false
let sectionFound = false
let entryPlaced  = false

while (i < lines.length) {
  const line = lines[i]

  // ── Found today's date block ──────────────────────────────────────────
  if (!dateFound && line.trim() === dateLine) {
    dateFound = true
    result.push(line)
    i++
    continue
  }

  if (dateFound && !entryPlaced) {
    // Inside today's block — look for the right section
    if (line.trim() === sectionLine) {
      sectionFound = true
      result.push(line)
      i++
      // Insert entry right after the section header
      result.push(entry)
      entryPlaced = true
      continue
    }

    // Hit the next date block before finding our section — insert section before it
    if (line.startsWith('## ') && line.trim() !== dateLine) {
      result.push(sectionLine)
      result.push(entry)
      result.push('')
      entryPlaced = true
      // fall through to push this line normally
    }
  }

  result.push(line)
  i++
}

// ── Today's date block didn't exist yet — insert at top after "# Changelog" ──
if (!dateFound) {
  const headerIdx = result.findIndex(l => l.startsWith('# '))
  const insertAt  = headerIdx >= 0 ? headerIdx + 1 : 0
  result.splice(insertAt, 0, '', dateLine, '', sectionLine, entry, '')
  entryPlaced = true
}

// ── Date found but section never closed and no next date block ───────────────
if (dateFound && !entryPlaced) {
  result.push(sectionLine)
  result.push(entry)
  result.push('')
}

fs.writeFileSync(changelogPath, result.join('\n'), 'utf8')
process.stdout.write(`changelog: [${today}] ${section} — ${entry}\n`)
