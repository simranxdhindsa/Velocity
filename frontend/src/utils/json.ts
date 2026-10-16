// JSON helpers for showing logged tool output (no React).

/** Parses text that is a JSON object or array; null for anything else. */
export function parseJsonObject(text: string): object | null {
  const t = text.trim()
  if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']'))) return null
  try {
    const v: unknown = JSON.parse(t)
    return v !== null && typeof v === 'object' ? v : null
  } catch {
    return null // e.g. a summary cut short mid-object
  }
}

export type JsonTokenKind = 'key' | 'string' | 'number' | 'bool' | 'null' | 'punct'

export interface JsonToken {
  text: string
  kind: JsonTokenKind
}

// Strings (a trailing ':' marks a key), literals, numbers.
const TOKEN_RE = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g

/** Splits pretty-printed JSON into tokens for syntax colouring. */
export function tokenizeJson(pretty: string): JsonToken[] {
  const out: JsonToken[] = []
  let last = 0
  for (const m of pretty.matchAll(TOKEN_RE)) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: pretty.slice(last, i), kind: 'punct' })
    if (m[1] !== undefined) {
      out.push({ text: m[1], kind: m[2] ? 'key' : 'string' })
      if (m[2]) out.push({ text: m[2], kind: 'punct' })
    } else if (m[3] !== undefined) {
      out.push({ text: m[0], kind: 'bool' })
    } else if (m[0] === 'null') {
      out.push({ text: m[0], kind: 'null' })
    } else {
      out.push({ text: m[0], kind: 'number' })
    }
    last = i + m[0].length
  }
  if (last < pretty.length) out.push({ text: pretty.slice(last), kind: 'punct' })
  return out
}
