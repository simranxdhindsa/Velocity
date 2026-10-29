import type { ReactNode } from 'react'
import './Checkbox.css'

interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  disabled?: boolean
}

export function Checkbox({ checked, onChange, label, disabled = false }: CheckboxProps) {
  return (
    <label className={`vl-checkbox${disabled ? ' vl-checkbox--disabled' : ''}`}>
      <input
        type="checkbox"
        className="vl-checkbox-input"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
      />
      <span className="vl-checkbox-box">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
      {label && <span className="vl-checkbox-label">{label}</span>}
    </label>
  )
}
