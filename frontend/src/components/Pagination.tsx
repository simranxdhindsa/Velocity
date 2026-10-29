import { memo } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { CustomDropdown } from '@/components/CustomDropdown'
import { PAGE_SIZE_OPTIONS } from '@/utils/pagination'
import '@/styles/components/pagination.css'

// Page controls for server-paged lists: "Showing 26-50 of 143", previous /
// next, and page numbers with gaps (1 … 4 5 6 … 12), plus an optional
// "Show 10 per page" selector. Hidden when everything fits on the smallest
// page. On phones the numbers collapse to "Page 2 of 6".

interface Props {
  page: number            // 1-based
  pageSize: number
  total: number
  onChange: (page: number) => void
  disabled?: boolean      // while a page is loading
  noun?: string           // "transactions" in "Showing 1-25 of 143 transactions"
  /** Shows the per-page selector; the caller resets to page 1. */
  onPageSizeChange?: (size: number) => void
  pageSizeOptions?: number[]
}


/** Page numbers to show, with 0 marking a gap. */
function pageItems(page: number, last: number): number[] {
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1)
  const items = new Set([1, last, page - 1, page, page + 1])
  if (page <= 3) [2, 3, 4].forEach(p => items.add(p))
  if (page >= last - 2) [last - 3, last - 2, last - 1].forEach(p => items.add(p))
  const sorted = [...items].filter(p => p >= 1 && p <= last).sort((a, b) => a - b)
  const out: number[] = []
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push(0)
    out.push(p)
  })
  return out
}

export const Pagination = memo(function Pagination({
  page, pageSize, total, onChange, disabled, noun, onPageSizeChange, pageSizeOptions = PAGE_SIZE_OPTIONS,
}: Props) {
  const last = Math.max(1, Math.ceil(total / pageSize))
  // With a size selector, stay visible while a smaller page size would page.
  if (total <= (onPageSizeChange ? Math.min(...pageSizeOptions) : pageSize)) return null
  const from = (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)
  const go = (p: number) => {
    if (!disabled && p >= 1 && p <= last && p !== page) onChange(p)
  }

  return (
    <nav className="pgn" aria-label="Pagination">
      <div className="pgn-info">
        <span className="pgn-range">
          Showing {from}-{to} of {total}{noun ? ` ${noun}` : ''}
        </span>
        {onPageSizeChange && (
          <label className="pgn-size">
            Show
            <CustomDropdown
              className="pgn-size-dropdown"
              options={pageSizeOptions.map(n => ({ value: String(n), label: String(n) }))}
              value={String(pageSize)}
              onChange={v => onPageSizeChange(Number(v))}
            />
            per page
          </label>
        )}
      </div>
      <div className="pgn-controls">
        <button className="pgn-btn pgn-btn--step" onClick={() => go(page - 1)} disabled={disabled || page === 1} aria-label="Previous page">
          <ChevronLeft size={15} />
          <span className="pgn-step-label">Previous</span>
        </button>
        <div className="pgn-pages">
          {pageItems(page, last).map((p, i) =>
            p === 0 ? (
              <span key={`gap-${i}`} className="pgn-gap">…</span>
            ) : (
              <button
                key={p}
                className={`pgn-btn${p === page ? ' pgn-btn--active' : ''}`}
                onClick={() => go(p)}
                disabled={disabled}
                aria-current={p === page ? 'page' : undefined}
              >
                {p}
              </button>
            ),
          )}
        </div>
        <span className="pgn-compact">Page {page} of {last}</span>
        <button className="pgn-btn pgn-btn--step" onClick={() => go(page + 1)} disabled={disabled || page === last} aria-label="Next page">
          <span className="pgn-step-label">Next</span>
          <ChevronRight size={15} />
        </button>
      </div>
    </nav>
  )
})
