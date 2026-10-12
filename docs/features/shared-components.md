# Shared Frontend Components

Reusable components in `frontend/src/components/`. Always check here before building something inline.

---

## CustomDropdown

**File:** `frontend/src/components/CustomDropdown.tsx`  
**CSS:** `frontend/src/styles/components/custom-dropdown.css` (global, imported in `index.css`)

Drop-in replacement for native `<select>` across all pages. Follows the `pm-custom-dropdown` pattern.

### Key behaviours
- **Portal-rendered** — menu appended to `<body>` via `createPortal`; `position: fixed; z-index: 9999`. Always floats above panels, modals, and stacking contexts
- **Auto-flips** — if not enough space below the trigger, menu opens upward
- **Repositions on scroll/resize** so it tracks the trigger
- **Auto-search** — search box appears automatically when `options.length > 7` (or force with `searchable` prop)
- **Fixed-height scrollable list** — `maxHeight: 200px` (configurable via `menuMaxHeight`)
- Outside-click closes the menu

### Props

```ts
interface CustomDropdownProps<T extends string = string> {
  options: DropdownOption<T>[]   // { value, label, icon? }
  value: T
  onChange: (value: T) => void
  icon?: ReactNode               // icon before the label in trigger
  placeholder?: string
  className?: string
  searchable?: boolean           // force-enable search (auto when options > 7)
  menuMaxHeight?: number         // default 200
}
```

### Usage

```tsx
import { CustomDropdown } from '../components/CustomDropdown'

<CustomDropdown
  options={[
    { value: 'asia', label: 'Asia/Kolkata (IST)' },
    { value: 'utc',  label: 'UTC' },
  ]}
  value={timezone}
  onChange={setTimezone}
/>
```

### Making a dropdown fill its container

```css
.my-dd { width: 100%; }
.my-dd .pm-custom-dropdown-trigger { width: 100%; justify-content: space-between; }
```

```tsx
<CustomDropdown className="my-dd" ... />
```

---

## ClockTimePicker

**File:** `frontend/src/components/ClockTimePicker.tsx`  
**CSS:** `frontend/src/styles/components/clock-time-picker.css` (imported inside component)

Analog clock-face time picker. Same trigger button and `HH:MM` 24-hour interface as `TimePicker`, but opens a centered modal dialog with a clock face instead of a dropdown column list. Use this where there's enough vertical space for the dialog (rule editors, settings forms). Use `TimePicker` for compact inline pickers (message cards, etc.).

### Key behaviours
- **Modal overlay** (fixed, `z-index: 9999`), click outside to cancel
- Two-phase: click hour → auto-advances to minute selection
- Hour/minute display boxes clickable to switch phase
- AM/PM toggle
- Keyboard icon switches to manual text input (`H:MM AM/PM` or `HH:MM`)
- Escape key closes without saving

### Props

```ts
interface ClockTimePickerProps {
  value: string        // HH:MM 24-hour
  onChange: (v: string) => void
  className?: string
  placeholder?: string
}
```

### Usage

```tsx
import { ClockTimePicker } from '../components/ClockTimePicker'

<ClockTimePicker value={form.schedule_time} onChange={v => set({ schedule_time: v })} />
```

---

## TimePicker

**File:** `frontend/src/components/TimePicker.tsx`  
**CSS:** `frontend/src/styles/components/time-picker.css` (global, imported in `index.css`)

Custom time selector replacing `<input type="time">`. Styled to match `pm-custom-dropdown-trigger`.

### Key behaviours
- **Portal-rendered** at `z-index: 9999`, auto-flips above trigger if needed
- Three scrollable columns: **Hour** (1–12) · **Minute** (00–55 in steps of 5) · **AM/PM**
- Columns auto-scroll to the selected value on open
- Stores and emits `HH:MM` **24-hour** format — direct replacement for `<input type="time">`

### Props

```ts
interface TimePickerProps {
  value: string        // HH:MM 24-hour
  onChange: (v: string) => void
  className?: string
  placeholder?: string
}
```

### Usage

```tsx
import { TimePicker } from '../components/TimePicker'

<TimePicker value={form.schedule_time} onChange={v => set({ schedule_time: v })} />
```

---

## ConfirmModal

**File:** `frontend/src/components/ConfirmModal.tsx`  
**CSS:** `frontend/src/styles/modals.css` (`.cm-*` classes, global)

Replaces all browser `confirm()` calls. Portal-rendered, centred with backdrop.

### Key behaviours
- `z-index: 10000` — above everything including other modals
- Three variants: `danger` (Trash icon, red button), `warning` (triangle), `info` (circle)
- Backdrop click cancels
- Optional `detail` subtext below the main message
- `open` prop defaults to `true` — use conditional render OR `open={bool}` (both work)

### Props

```ts
interface ConfirmModalProps {
  open?: boolean          // default true; renders nothing when false
  title?: string          // bold heading (optional)
  message: string         // main text
  detail?: string         // muted subtext
  confirmLabel?: string   // default 'Confirm'
  cancelLabel?: string    // default 'Cancel'
  variant?: 'danger' | 'warning' | 'info'  // default 'danger'
  onConfirm: () => void
  onCancel: () => void
}
```

### Usage — conditional render (preferred for delete flows)

```tsx
import { ConfirmModal } from '../components/ConfirmModal'

const [showDelete, setShowDelete] = useState(false)

// In JSX:
<button onClick={() => setShowDelete(true)}>Delete</button>

{showDelete && (
  <ConfirmModal
    message={`Delete "${item.name}"?`}
    detail="This cannot be undone."
    confirmLabel="Delete"
    variant="danger"
    onConfirm={handleDelete}
    onCancel={() => setShowDelete(false)}
  />
)}
```

### Usage — open prop

```tsx
<ConfirmModal
  open={showDelete}
  message="Are you sure?"
  onConfirm={handleDelete}
  onCancel={() => setShowDelete(false)}
/>
```

---

## HoverCard

**File:** `frontend/src/components/HoverCard.tsx`  
**CSS:** `frontend/src/styles/components/hover-card.css`

Portal hover overlay. See existing usages in tracking views.

---

## IssueDetailPanel

**File:** `frontend/src/components/IssueDetailPanel.tsx`

YouTrack issue detail slide-in panel.

---

## SprintControlsBar

**File:** `frontend/src/components/SprintControlsBar.tsx`

`db-controls` bar — left mode dropdown + sprint selector + children slot.

---

## CalendarView

**File:** `frontend/src/components/calendar/CalendarView.tsx`

Use for all date-range displays.

---

## SlackMessageText

**File:** `frontend/src/components/SlackMessageText.tsx`  
**Helpers:** `frontend/src/utils/slackMarkdown.ts` (`renderSlackMessage`, `slackToMarkdown`, `slackPlainText`)  
**CSS:** `frontend/src/styles/components/slack-message-text.css` (imported by the component)

**Use it everywhere Velocity shows a message's text** (anything sent to or read from Slack, bot replies, notifications, templates). Never print message text raw: messages carry Markdown and Slack mrkdwn (tables, `*bold*`, `<@U123>` mentions) that show as junk otherwise.

### Key behaviours
- Renders the way Slack shows it: Markdown tables as bordered tables sized to their content (wide ones scroll inside their own box), Slack `*bold*` and `**bold**`, `_italic_`, `~strike~`, code, code blocks, lists, links (new tab), `<@U123>` → `@Name` via `userMap`, `<#C123|name>` → `#name`.
- Uses `marked` + `DOMPurify` (sanitized HTML).
- `compact` prop: card previews capped at about three lines; fades out only when the text is actually cut off.
- Wins over a container's `white-space: pre-wrap` (uses `div.smt-body`), so it can take an existing text class via `className`.
- For short cut-off snippets and search strings (e.g. a 90-char preview) use `slackPlainText()` instead: rendering half a table looks broken, so snippets stay plain with markers stripped and table rows flattened to `a · b · c`.

### Props
```ts
{ text: string; userMap?: Map<string, string>; className?: string; compact?: boolean; onClick?: () => void }
```

### Usage
```tsx
import { SlackMessageText } from '@/components/SlackMessageText'

<SlackMessageText text={msg.message} userMap={userNames} />              // full message
<SlackMessageText compact text={m.message_text} userMap={userMap} />     // card preview
```

Used in: Claude Queue (Update Reminders), Slack Messages hub, Slack inbox cards, Velocity Bot conversation log, Integrations message list, Slack reminder notes and saved templates, notification panel and Activity page.

---

## Global CSS component files

All imported in `index.css` under `/* Shared component overlays */`:

| File | What it styles |
|------|----------------|
| `styles/components/custom-dropdown.css` | `.cd-portal-menu`, `.cd-search-row`, `.cd-option-list` — portal menu for `CustomDropdown` |
| `styles/components/time-picker.css` | `.tp-menu`, `.tp-col`, `.tp-ampm-col`, `.tp-colon` — `TimePicker` portal menu |
| `styles/components/hover-card.css` | `.hc-*` — `HoverCard` |
| `styles/components/stat-carousel.css` | `.stat-carousel-*` |
| `styles/modals.css` | `.cm-*` (ConfirmModal portal), `.confirm-modal-*` (shared icon/button styles), `.ci-*` (Create Issue modal) |
