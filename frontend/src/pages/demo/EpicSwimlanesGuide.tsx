import { useEffect, useState } from 'react'
import api, { API_URL } from '@/services/api'

// In-app how-to guide at /demo/epic-swimlanes. App.tsx renders it only after
// login, and its images come from the login-protected /api/demo-media route,
// so the board screenshots are never public.

/** Fetches a protected guide image with the login header and returns a blob URL. */
function useGuideImage(file: string): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    fetch(`${API_URL}/demo-media/epic-swimlanes/${file}`, { headers: { Authorization: `Bearer ${api.getToken() ?? ''}` } })
      .then(res => (res.ok ? res.blob() : null))
      .then(blob => {
        if (!blob || cancelled) return
        url = URL.createObjectURL(blob)
        setSrc(url)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [file])
  return src
}

function GuideImage({ file, alt }: { file: string; alt: string }) {
  const src = useGuideImage(file)
  return src ? <img className="dg-img" src={src} alt={alt} /> : <div className="dg-img dg-img--loading skeleton" aria-label="Loading image" />
}

export default function EpicSwimlanesGuide() {
  return (
    <div className="dg-page">
      <div className="dg-wrap">
        <a className="dg-back" href="/">Back to Velocity</a>
        <header>
          <h1 className="dg-title">Moving cards into epic swimlanes</h1>
          <p className="dg-lede">How to create a card on the Ardoise board, put it under a feature epic such as Composer, and make a new swimlane for a new feature. Every step below was done live on the Sprint 16 board with a test card and a test epic, both deleted afterwards.</p>
        </header>

        <figure className="dg-figure">
          <GuideImage file="demo.gif" alt="Screen recording: creating a card with New card, dragging it into the Composer swimlane, creating a new swimlane and dragging the card into it" />
          <figcaption>Full run, recorded in YouTrack: New card, drag into Composer, New swimlane, drag into the new swimlane.</figcaption>
        </figure>

        <div className="dg-facts">
          <div className="dg-fact"><b>Rows are epics now</b><span>Swimlanes no longer come from Type. Picking Hotfix or Regression does not move a card to a row any more.</span></div>
          <div className="dg-fact"><b>Drag sideways</b><span>Changes the column, so the ticket State (To Do, In Progress and so on).</span></div>
          <div className="dg-fact"><b>Drag up or down</b><span>Changes the epic. YouTrack sets the "Subtask of" link for you and removes the old one.</span></div>
        </div>

        <section className="dg-section">
          <h2><span className="dg-tag">Part 1</span>Create a card</h2>
          <ol>
            <li>Open the Ardoise board on the current sprint.</li>
            <li>Click <span className="dg-ui">New card</span> at the top right.</li>
            <li>Type the summary, then set <span className="dg-ui">Type</span> and <span className="dg-ui">Subsystem</span> in the right panel. Type starts as Feature.</li>
            <li>Click <span className="dg-ui">Create</span>. The card lands in the <span className="dg-ui">Uncategorized Cards</span> row at the bottom, in the Backlog column, because it has no epic yet.</li>
          </ol>
        </section>

        <section className="dg-section">
          <h2><span className="dg-tag">Part 2</span>Move it into Composer</h2>
          <ol>
            <li>Make the card and the Composer row visible together. Either click the arrow next to each epic name to collapse the rows, or type the card's name in <span className="dg-ui">Filter cards on the board</span>. The filter hides other cards but keeps every row.</li>
            <li>Drag the card onto the Composer row, into the <span className="dg-ui">To Do</span> column. Dropping on a collapsed row header works too.</li>
            <li>Expand Composer. The card is in its To Do column, and the ticket now shows <span className="dg-ui">Subtask of ARD-3233 Composer</span>.</li>
          </ol>
        </section>

        <section className="dg-section">
          <h2><span className="dg-tag">Part 3</span>Make a new swimlane</h2>
          <ol>
            <li>Click <span className="dg-ui">New swimlane...</span> at the bottom right of the board. The form opens with Type already set to Epic.</li>
            <li>Use the plain feature name as the summary, for example "Composer".</li>
            <li>Set <span className="dg-ui">Subsystem</span> to <span className="dg-ui">Epic</span>. This matters: Velocity only treats a ticket as a feature epic when Type and Subsystem are both Epic.</li>
            <li>Click <span className="dg-ui">Create</span>. The new row appears on the current sprint.</li>
            <li>Drag cards into it the same way as Part 2. The card moves out of its old epic and into the new one.</li>
          </ol>
          <figure className="dg-figure">
            <GuideImage file="result.jpg" alt="Board showing the new TEST Swimlane Demo row with the test card in its To Do column" />
            <figcaption>End state: the test card sits in the new TEST Swimlane Demo row, and its epic is now that new swimlane.</figcaption>
          </figure>
        </section>

        <div className="dg-note"><strong>Faster way:</strong> ask Claude or ChatGPT through Velocity, for example "create a ticket for ... it is part of Composer" or "make a new epic for ...". Velocity sets the epic link, Subsystem Epic and the sprint for you, and new sprints made through Velocity get every open epic automatically.</div>
      </div>
    </div>
  )
}
