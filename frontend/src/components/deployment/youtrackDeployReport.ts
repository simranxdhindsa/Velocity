// Pure helpers for the YouTrack Deployment Report tab (PMReportsPage →
// YouTrackStageReport). Keep in sync with buildDeploymentReportText in
// backend/internal/handlers/deployment_report.go, which the MCP tool
// generate_deployment_report uses for the same text.

export type DRTicketStatus = 'pending' | 'generating' | 'done' | 'failed'

export interface DRTicket {
  id: string
  idReadable: string
  summary: string
  description: string
  issueType: string
  subsystem: string
  ytUrl: string
  updatedAt: number
  epicId: string
  epicName: string
  fixStatement: string | null
  status: DRTicketStatus
  error?: string
}

export interface DREpicSection {
  epicId: string
  epicName: string
  epicUrl: string
  items: DRTicket[]
}

export interface DRTypeSection {
  label: string
  items: DRTicket[]
}

export const DR_EPIC_TITLE = 'Features in this release'

// Type → display category label, in render order
const TYPE_CATEGORY_ORDER = ['Features', 'Enhancements', 'Bug Fixes', 'Hotfixes', 'Other']

const DR_TYPE_CATEGORIES: Record<string, string> = {
  bug:         'Bug Fixes',
  regression:  'Bug Fixes',
  feature:     'Features',
  enhancement: 'Enhancements',
  hotfix:      'Hotfixes',
}

function drCategory(issueType: string): string {
  return DR_TYPE_CATEGORIES[issueType.toLowerCase()] ?? 'Other'
}

const DR_TYPE_COLORS: Record<string, string> = {
  Bug:         'drt-type--bug',
  Regression:  'drt-type--bug',
  Feature:     'drt-type--feature',
  Enhancement: 'drt-type--enhancement',
  Hotfix:      'drt-type--hotfix',
}

export function drTypeClass(issueType: string): string {
  return DR_TYPE_COLORS[issueType] ?? 'drt-type--other'
}

// Subsystem sort order used within each section
const SUBSYSTEM_ORDER = ['FE UI', 'BE UI', 'FE Studio', 'BE Studio', 'FE MC', 'BE MC', 'BE RAG']

function subsystemRank(subsystem: string): number {
  const idx = SUBSYSTEM_ORDER.indexOf((subsystem ?? '').trim())
  return idx === -1 ? SUBSYSTEM_ORDER.length : idx
}

function categoryRank(issueType: string): number {
  const idx = TYPE_CATEGORY_ORDER.indexOf(drCategory(issueType))
  return idx === -1 ? TYPE_CATEGORY_ORDER.length : idx
}

// Returns subsystem label to display (pass-through known ones, "Others" for unknown)
export function subsystemLabel(subsystem: string): string {
  const norm = (subsystem ?? '').trim()
  return norm || 'Others'
}

/** Epic tickets are headings, never report lines. */
export function isEpicType(issueType: string): boolean {
  return issueType.trim().toLowerCase() === 'epic'
}

/**
 * Groups generated tickets for the report: one section per feature epic
 * (biggest first, tickets by type then subsystem), then the remaining tickets
 * in type sections (Features / Enhancements / Bug Fixes / Hotfixes / Other)
 * sorted by subsystem. Only tickets with a fix statement are included.
 */
export function buildReportSections(tickets: DRTicket[], epicUrl: (id: string) => string): { epics: DREpicSection[]; sections: DRTypeSection[] } {
  const epicMap = new Map<string, DREpicSection>()
  const typeMap = new Map<string, DRTicket[]>()
  for (const t of tickets) {
    if (t.status !== 'done' || !t.fixStatement) continue
    if (t.epicId) {
      if (!epicMap.has(t.epicId)) epicMap.set(t.epicId, { epicId: t.epicId, epicName: t.epicName, epicUrl: epicUrl(t.epicId), items: [] })
      epicMap.get(t.epicId)!.items.push(t)
      continue
    }
    const cat = drCategory(t.issueType)
    if (!typeMap.has(cat)) typeMap.set(cat, [])
    typeMap.get(cat)!.push(t)
  }
  // Biggest first; same size by epic ID, matching the backend's order.
  const epics = [...epicMap.values()].sort((a, b) => b.items.length - a.items.length || (a.epicId < b.epicId ? -1 : a.epicId > b.epicId ? 1 : 0))
  for (const e of epics) {
    e.items.sort((a, b) => categoryRank(a.issueType) - categoryRank(b.issueType) || subsystemRank(a.subsystem) - subsystemRank(b.subsystem))
  }
  const sections: DRTypeSection[] = []
  for (const label of TYPE_CATEGORY_ORDER) {
    const items = typeMap.get(label)
    if (!items?.length) continue
    items.sort((a, b) => subsystemRank(a.subsystem) - subsystemRank(b.subsystem))
    sections.push({ label, items })
  }
  return { epics, sections }
}

// Line format: "ARD-123 FE UI: fix statement"
function formatLine(t: DRTicket): string {
  return `${t.idReadable} ${subsystemLabel(t.subsystem)}: ${t.fixStatement}`
}

const INTRO = 'Hey team 👋 here is the list of changes in this deployment:'

export function buildDeployReport(tickets: DRTicket[]): string {
  const { epics, sections } = buildReportSections(tickets, () => '')
  const parts: string[] = [INTRO]
  if (epics.length) {
    const blocks = epics.map(e => [`${e.epicName} (${e.epicId})`, ...e.items.map(formatLine)].join('\n'))
    parts.push([DR_EPIC_TITLE, ...blocks].join('\n\n'))
  }
  for (const { label, items } of sections) {
    parts.push(`${label}\n${items.map(formatLine).join('\n')}`)
  }
  return parts.join('\n\n')
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function htmlLine(t: DRTicket): string {
  const idPart = t.ytUrl ? `<a href="${esc(t.ytUrl)}">${esc(t.idReadable)}</a>` : esc(t.idReadable)
  return `<li>${idPart} ${esc(subsystemLabel(t.subsystem))}: ${esc(t.fixStatement ?? '')}</li>`
}

export function buildDeployReportHtml(tickets: DRTicket[], epicUrl: (id: string) => string): string {
  const { epics, sections } = buildReportSections(tickets, epicUrl)
  const parts: string[] = [`<p>${INTRO}</p>`]
  if (epics.length) {
    parts.push(`<p><strong>${DR_EPIC_TITLE}</strong></p>`)
    for (const e of epics) {
      const idPart = e.epicUrl ? `<a href="${esc(e.epicUrl)}">${esc(e.epicId)}</a>` : esc(e.epicId)
      parts.push(`<p>${esc(e.epicName)} (${idPart})</p><ul>${e.items.map(htmlLine).join('')}</ul>`)
    }
    parts.push('<p>&nbsp;</p>')
  }
  for (const { label, items } of sections) {
    parts.push(`<p>${esc(label)}</p><ul>${items.map(htmlLine).join('')}</ul><p>&nbsp;</p>`)
  }
  return parts.join('')
}
