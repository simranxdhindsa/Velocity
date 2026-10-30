// Types and pure helpers for the Board toolbar and its filtering. No React.

export type SortKey = 'newest' | 'priority' | 'alpha'
export type SwimlaneBy = 'none' | 'assignee' | 'priority' | 'board'

/** One selectable value in a filter menu. `count` is how many loaded tickets carry it. */
export interface FilterOption {
  name: string
  color?: string
  count: number
}

/** Stands in for tickets with no subsystem set, so they can be filtered too. */
export const NO_SUBSYSTEM = 'No subsystem'

export function priorityOrder(name: string): number {
  const p = (name || '').toLowerCase()
  if (p.includes('critical') || p.includes('show-stopper') || p.includes('blocker')) return 0
  if (p.includes('major')) return 1
  if (p.includes('normal') || p.includes('medium')) return 2
  if (p.includes('minor') || p.includes('cosmetic') || p.includes('low')) return 3
  return 4
}

/**
 * Builds filter menu options live from the tickets on the board.
 * `catalog` (e.g. the project's configured subsystems) is listed first in its own
 * order, so values with no loaded tickets still appear with a 0 count. Anything on
 * the board that the catalog does not know about is appended alphabetically.
 */
export function buildFilterOptions(
  values: string[],
  catalog: { name: string; background?: string }[] = [],
): FilterOption[] {
  const counts = new Map<string, number>()
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)

  const options: FilterOption[] = catalog
    .filter(c => c.name)
    .map(c => ({ name: c.name, color: c.background || undefined, count: counts.get(c.name) ?? 0 }))

  const known = new Set(options.map(o => o.name))
  const extra = [...counts.keys()]
    .filter(name => !known.has(name))
    .sort((a, b) => (a === NO_SUBSYSTEM ? 1 : b === NO_SUBSYSTEM ? -1 : a.localeCompare(b)))
  for (const name of extra) options.push({ name, count: counts.get(name) ?? 0 })

  return options
}
