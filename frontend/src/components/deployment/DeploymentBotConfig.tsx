import React, { useState, useEffect } from 'react'
import { Save, Check, Loader2, RotateCcw } from 'lucide-react'
import api from '../../services/api'
import { SprintScanLoader } from '../brand/VelocityLoaders'
import type { DeploymentBotConfig, DeploymentSectionConfig } from '../../services/api'

const DEFAULT_CONFIG: DeploymentBotConfig = {
  systemPrompt: `You are a technical writer creating client-facing deployment reports.

You will receive a ticket title and description. The description may be a rough internal note written by a developer (e.g. "is now fixed", "added support for X").

Your job is to rewrite it as a single polished, professional fix statement for a client deployment report. Rules:
- Write in past tense, from the user's perspective (what they now experience)
- Be 1-2 sentences. Do not pad or over-explain.
- Remove ALL internal prefixes: priority tags (P0, P1, A2, etc.), platform tags (FE, BE, UI, MC, Studio), ticket IDs, and jargon
- Start with the subject of what changed (e.g. "The restart conversation button...", "Avatar playback...")
- If the description already says what was fixed clearly, use it as the basis — do not invent details
- Sound polished and client-ready

Respond with ONLY the fix statement. No preamble, no labels, no quotes.`,
  sections: [
    { platform: 'UI', header: 'UI', enabled: true },
    { platform: 'Studio', header: 'Studio', enabled: true },
    { platform: 'Mission Control', header: 'Mission Control', enabled: true },
    { platform: 'Backend', header: 'Backend / Platform', enabled: true },
    { platform: 'Uncategorized', header: 'Other', enabled: true },
  ],
}

interface Props {
  onConfigChange?: (cfg: DeploymentBotConfig) => void
}

export default function DeploymentBotConfig({ onConfigChange }: Props) {
  const [config, setConfig] = useState<DeploymentBotConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  useEffect(() => {
    api.getAsanaDeploymentConfig().then(res => {
      if (res.success && res.data) {
        setConfig(res.data)
        onConfigChange?.(res.data)
      }
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const updateSection = (idx: number, changes: Partial<DeploymentSectionConfig>) => {
    setConfig(prev => ({
      ...prev,
      sections: prev.sections.map((s, i) => i === idx ? { ...s, ...changes } : s),
    }))
  }

  const handleSave = async () => {
    setSaveState('saving')
    try {
      const res = await api.putAsanaDeploymentConfig(config)
      if (res.success) {
        setSaveState('saved')
        onConfigChange?.(config)
        setTimeout(() => setSaveState('idle'), 2500)
      } else {
        setSaveState('error')
        setTimeout(() => setSaveState('idle'), 3000)
      }
    } catch {
      setSaveState('error')
      setTimeout(() => setSaveState('idle'), 3000)
    }
  }

  const handleReset = () => {
    setConfig(DEFAULT_CONFIG)
    onConfigChange?.(DEFAULT_CONFIG)
  }

  if (loading) {
    return (
      <div className="dr-bot-config">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <SprintScanLoader size={40} />
        </div>
      </div>
    )
  }

  return (
    <div className="dr-bot-config">
      <div style={{ marginBottom: '1rem' }}>
        <label className="dr-bot-config-label">System Prompt</label>
        <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
          Instructs the AI how to rewrite ticket titles into polished fix statements.
        </p>
        <textarea
          className="dr-textarea"
          rows={14}
          value={config.systemPrompt}
          onChange={e => setConfig(prev => ({ ...prev, systemPrompt: e.target.value }))}
          maxLength={8000}
          style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}
        />
        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
          {config.systemPrompt.length}/8000
        </span>
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <label className="dr-bot-config-label">Report Sections</label>
        <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
          Toggle which platforms appear in exported reports and customize their headers.
        </p>
        {config.sections.map((section, idx) => (
          <div key={section.platform} className="dr-section-row">
            <input
              type="checkbox"
              checked={section.enabled}
              onChange={e => updateSection(idx, { enabled: e.target.checked })}
              style={{ accentColor: 'var(--color-primary)', flexShrink: 0 }}
            />
            <span className="dr-section-name" style={{ minWidth: '120px' }}>{section.platform}</span>
            <input
              type="text"
              className="dr-section-header-input"
              value={section.header}
              onChange={e => updateSection(idx, { header: e.target.value })}
              placeholder="Header text"
            />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <button
          className={`btn-sm ${saveState === 'saved' ? 'btn-success' : saveState === 'error' ? 'btn-danger' : 'btn-primary'}`}
          onClick={handleSave}
          disabled={saveState === 'saving'}
        >
          {saveState === 'saving' ? <Loader2 size={13} className="animate-spin" /> : saveState === 'saved' ? <Check size={13} /> : <Save size={13} />}
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved!' : saveState === 'error' ? 'Error' : 'Save'}
        </button>
        <button className="btn-ghost btn-sm" onClick={handleReset}>
          <RotateCcw size={13} /> Reset
        </button>
      </div>
    </div>
  )
}
