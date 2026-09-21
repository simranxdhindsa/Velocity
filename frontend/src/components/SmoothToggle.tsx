import './SmoothToggle.css'

interface SmoothToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
}

export function SmoothToggle({ checked, onChange, disabled = false, label }: SmoothToggleProps) {
  return (
    <label className={`smooth-toggle ${disabled ? 'smooth-toggle--disabled' : ''}`}>
      <input
        type="checkbox"
        className="smooth-toggle-input"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
      />
      <span className={`smooth-toggle-track ${checked ? 'smooth-toggle-track--on' : ''}`}>
        <span className="smooth-toggle-thumb" />
      </span>
      {label && <span className="smooth-toggle-text">{label}</span>}
    </label>
  )
}
