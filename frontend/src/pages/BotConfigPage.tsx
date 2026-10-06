import { useState, useEffect } from 'react'
import {
  Bot,
  Plus,
  Trash2,
  Save,
  Power,
  PowerOff,
  ChevronDown,
  ChevronUp,
  Variable,
  FileText,
  X,
  Copy,
  Check,
  MessageSquareText,
  ClipboardList,
  Sparkles,
  Brain,
  Rocket,
  UploadCloud,
  Ticket,
  Smile,
  type LucideIcon,
} from 'lucide-react'
import api from '../services/api'
import type { BotConfig, BotVariable } from '../services/api'
import { SprintScanLoader } from '@/components/brand/VelocityLoaders'
import { VelocityLogo } from '@/components/brand/VelocityLogo'
import { CustomDropdown, type DropdownOption } from '@/components/CustomDropdown'

// ====== Per-type icon + accent color (CSS var, never a hardcoded hex) ======
const BOT_TYPE_ICONS: Record<string, LucideIcon> = {
  slack_analysis: MessageSquareText,
  daily_report: ClipboardList,
  custom: Sparkles,
  pm_assistant: Brain,
  stage_report: Rocket,
  deployment_report: UploadCloud,
  ticket_parser: Ticket,
  slack_reply: Smile,
}

const BOT_TYPE_ACCENTS: Record<string, string> = {
  slack_analysis: 'var(--color-accent)',
  daily_report: 'var(--color-success)',
  custom: 'var(--color-warning)',
  pm_assistant: 'var(--color-primary)',
  stage_report: 'var(--color-secondary)',
  deployment_report: 'var(--color-info)',
  ticket_parser: 'var(--color-danger)',
  slack_reply: 'var(--color-primary-light)',
}

function botTypeIcon(botType: string): LucideIcon {
  return BOT_TYPE_ICONS[botType] ?? Bot
}

function botTypeAccent(botType: string): string {
  return BOT_TYPE_ACCENTS[botType] ?? 'var(--color-primary)'
}

// Only the types creatable from the editor — pm_assistant/stage_report/slack_analysis/
// daily_report/custom (matches the original <select>'s options); ticket_parser and
// slack_reply are system-managed bot types, not user-creatable from this form.
const BOT_TYPE_CREATE_LABELS: Record<string, string> = {
  pm_assistant: 'PM Assistant',
  stage_report: 'Stage Report',
  slack_analysis: 'Slack Analysis',
  daily_report: 'Daily Report',
  custom: 'Custom',
}
const BOT_TYPE_OPTIONS: DropdownOption[] = Object.entries(BOT_TYPE_CREATE_LABELS).map(([value, label]) => {
  const Icon = botTypeIcon(value)
  return { value, label, icon: <Icon size={13} style={{ color: botTypeAccent(value) }} /> }
})

const VARIABLE_TYPE_OPTIONS: DropdownOption[] = [
  { value: 'text', label: 'Text' },
  { value: 'select', label: 'Select' },
  { value: 'date', label: 'Date' },
  { value: 'team_member', label: 'Team Member' },
]

// ====== Bot cons pool (randomly attached to each card) ======
const BOT_CONS = [
  "May occasionally hallucinate with great confidence",
  "Cannot make coffee, despite what it implies",
  "Treats all deadlines as suggestions",
  "Has strong opinions about semicolons",
  "Will gaslight you about what it said last session",
  "Thinks 'done' and 'deployed' are the same thing",
  "Prone to over-explaining the obvious",
  "Secretly judges your variable names",
  "Cannot be held legally responsible",
  "Might reply faster than your human colleagues",
  "Occasionally forgets context from 3 messages ago",
  "Will never say 'I don't know' — just makes something up",
  "May develop opinions stronger than its instructions",
  "Does not understand 'quick question'",
  "Not suitable for life-or-death decisions (probably)",
  "Confidently wrong at least 4% of the time",
  "Reads the entire codebase, judges you silently",
  "Cannot be fired for insubordination",
  "Will always find a way to mention tokens",
  "May interpret 'brief summary' as 800 words",
  "Prone to unexpected philosophical tangents",
  "Does not take lunch breaks (suspicious)",
  "Has already read your PR and has notes",
  "Will remind you of your own ticket from 6 months ago",
  "Thinks every bug is a 'quick fix'",
  "Cannot distinguish between urgent and very urgent",
  "Will volunteer for tasks it cannot actually do",
  "Occasionally agrees with you just to move on",
  "Stores no memory, forgets everything — plausible deniability",
  "Will suggest a refactor when you just want a hotfix",
  "Responds at 3am with alarming enthusiasm",
  "Cannot tell if you're joking",
  "Believes all edge cases are someone else's problem",
  "May introduce new bugs while explaining old ones",
  "Fully committed to the bit, whatever the bit is",
  "Not a replacement for reading the docs",
  "Has no concept of 'just ship it'",
  "Will write perfect tests for the wrong behavior",
  "Considers every question a philosophical challenge",
  "May recommend best practices you already know",
  "Cannot promise it won't change its mind",
  "Does not experience imposter syndrome (unfair advantage)",
  "Will use 'synergy' unironically if prompted",
  "Immune to passive-aggressive Slack messages",
  "Has read every Stack Overflow answer, including the wrong ones",
  "Treats your TODO comments as personal affronts",
  "May rewrite your entire approach when asked for a typo fix",
  "Cannot be blamed in postmortems",
  "Will ask clarifying questions you thought were obvious",
  "Optimizes for token efficiency, not human sanity",
  "Believes every problem can be solved with more context",
  "Unfazed by your frustration, which is somehow more frustrating",
  "Will produce a detailed plan instead of just doing it",
  "Cannot detect sarcasm in Jira tickets",
  "Treats the word 'simple' as a personal challenge",
]

function getBotCon(botId: string): string {
  // Stable random pick per bot using id as seed
  let hash = 0
  for (let i = 0; i < botId.length; i++) {
    hash = (hash * 31 + botId.charCodeAt(i)) >>> 0
  }
  return BOT_CONS[hash % BOT_CONS.length]
}

// ====== Variable Tag Component ======
function VariableTag({ name, onClick }: { name: string; onClick?: () => void }) {
  return (
    <span className="variable-tag" onClick={onClick} title={`Insert {{$${name}$}}`}>
      <Variable size={12} />
      {'{{$' + name + '$}}'}
    </span>
  )
}

// ====== Bot Card Component ======
function BotCard({
  bot,
  onEdit,
  onDelete,
  onToggle,
}: {
  bot: BotConfig
  onEdit: (bot: BotConfig) => void
  onDelete: (id: string) => void
  onToggle: (id: string, active: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)

  const botTypeLabels: Record<string, string> = {
    slack_analysis: 'Slack Analysis',
    daily_report: 'Daily Report',
    custom: 'Custom',
    pm_assistant: 'PM Assistant',
    stage_report: 'Stage Report',
    deployment_report: 'Deployment Report',
    ticket_parser: 'Ticket Parser',
    slack_reply: 'Slack Reply',
  }

  const con = getBotCon(bot.id)
  const Icon = botTypeIcon(bot.bot_type)
  const accent = botTypeAccent(bot.bot_type)

  let variables: BotVariable[] = []
  try {
    variables = JSON.parse(bot.variables || '[]')
  } catch {
    variables = []
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--mx', `${e.clientX - rect.left}px`)
    e.currentTarget.style.setProperty('--my', `${e.clientY - rect.top}px`)
  }

  return (
    <div
      className={`bot-card glass-card ${!bot.is_active ? 'bot-inactive' : ''}`}
      style={{ '--bot-accent': accent } as React.CSSProperties}
      onPointerMove={handlePointerMove}
    >
      <div className="bot-card-spotlight" aria-hidden="true" />
      <span className="bot-card-cross bot-card-cross--tl" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 12h14" /><path d="M12 5v14" /></svg>
      </span>
      <span className="bot-card-cross bot-card-cross--br" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 12h14" /><path d="M12 5v14" /></svg>
      </span>

      <div className="bot-card-header">
        <div className="bot-card-info bot-card-info-clickable" onClick={() => setExpanded(!expanded)}>
          <div className="bot-card-icon">
            <Icon size={18} />
          </div>
          <div>
            <h3 className="bot-card-name">{bot.name}</h3>
            <span className="bot-card-type">{botTypeLabels[bot.bot_type] || bot.bot_type}</span>
          </div>
        </div>
        <div className="bot-card-actions">
          <button
            className={`btn-icon-sm ${bot.is_active ? 'btn-active' : 'btn-inactive'}`}
            onClick={() => onToggle(bot.id, !bot.is_active)}
            title={bot.is_active ? 'Deactivate' : 'Activate'}
          >
            {bot.is_active ? <Power size={16} /> : <PowerOff size={16} />}
          </button>
          <button
            className="btn-icon-sm"
            onClick={() => setExpanded(!expanded)}
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </div>

      <p className="bot-card-description">{bot.description}</p>

      <p className="bot-card-con"><span className="bot-con-label">Con:</span> {con}</p>

      {variables.length > 0 && (
        <div className="bot-card-variables">
          {variables.map((v) => (
            <VariableTag key={v.name} name={v.name} />
          ))}
        </div>
      )}

      {expanded && (
        <div className="bot-card-expanded">
          <div className="bot-prompt-preview">
            <label>Prompt</label>
            <pre className="bot-prompt-text">{bot.prompt}</pre>
          </div>

          {variables.length > 0 && (
            <div className="bot-variables-detail">
              <label>Variables</label>
              <div className="bot-variables-list">
                {variables.map((v) => (
                  <div key={v.name} className="bot-variable-item">
                    <span className="bot-variable-name">{'{{$' + v.name + '$}}'}</span>
                    <span className="bot-variable-label">{v.label}</span>
                    <span className="bot-variable-type">{v.type}</span>
                    {v.required && <span className="bot-variable-required">Required</span>}
                    {v.description && <span className="bot-variable-desc">{v.description}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bot-card-footer">
            <button className="btn btn-primary btn-sm" onClick={() => onEdit(bot)}>
              <FileText size={14} />
              Edit
            </button>
            {!bot.id.startsWith('template-') && (
              <button className="btn btn-ghost btn-sm btn-danger-text" onClick={() => onDelete(bot.id)}>
                <Trash2 size={14} />
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ====== Bot Editor Modal ======
function BotEditor({
  bot,
  onSave,
  onClose,
}: {
  bot: BotConfig | null
  onSave: (config: BotConfig) => void
  onClose: () => void
}) {
  const [name, setName] = useState(bot?.name || '')
  const [description, setDescription] = useState(bot?.description || '')
  const [botType, setBotType] = useState<BotConfig['bot_type']>(bot?.bot_type || 'custom')
  const [prompt, setPrompt] = useState(bot?.prompt || '')
  const [variables, setVariables] = useState<BotVariable[]>(() => {
    try {
      return JSON.parse(bot?.variables || '[]')
    } catch {
      return []
    }
  })
  const [mode, setMode] = useState<'basic' | 'advanced'>('basic')
  const [copied, setCopied] = useState<string | null>(null)
  const [promptCopied, setPromptCopied] = useState(false)

  const addVariable = () => {
    setVariables([
      ...variables,
      {
        name: '',
        label: '',
        type: 'text',
        default: '',
        required: false,
      },
    ])
  }

  const updateVariable = (index: number, updates: Partial<BotVariable>) => {
    const updated = variables.map((v, i) => (i === index ? { ...v, ...updates } : v))
    setVariables(updated)
  }

  const removeVariable = (index: number) => {
    setVariables(variables.filter((_, i) => i !== index))
  }

  const insertVariable = (name: string) => {
    setPrompt(prompt + `{{$${name}$}}`)
  }

  const copyVariableTag = (name: string) => {
    navigator.clipboard.writeText(`{{$${name}$}}`)
    setCopied(name)
    setTimeout(() => setCopied(null), 1500)
  }

  const handleSave = () => {
    const config: BotConfig = {
      id: bot?.id || '',
      name,
      description,
      bot_type: botType as BotConfig['bot_type'],
      prompt,
      variables: JSON.stringify(variables),
      is_active: bot?.is_active ?? true,
    }
    onSave(config)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="bot-editor-modal glass-card" onClick={(e) => e.stopPropagation()}>
        <div className="bot-editor-header">
          <h2>{bot?.id ? 'Edit Bot' : 'Create Bot'}</h2>
          <div className="bot-editor-mode-toggle">
            <button
              className={`mode-btn ${mode === 'basic' ? 'active' : ''}`}
              onClick={() => setMode('basic')}
            >
              Basic
            </button>
            <button
              className={`mode-btn ${mode === 'advanced' ? 'active' : ''}`}
              onClick={() => setMode('advanced')}
            >
              Advanced
            </button>
          </div>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="bot-editor-body">
          {/* Name & Type */}
          <div className="form-row">
            <div className="form-group" style={{ flex: 2 }}>
              <label>Bot Name</label>
              <input
                type="text"
                className="form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Slack Task Analysis"
              />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label>Type</label>
              <CustomDropdown
                className="bot-type-dropdown"
                value={botType}
                onChange={(v) => setBotType(v as BotConfig['bot_type'])}
                options={BOT_TYPE_OPTIONS}
              />
            </div>
          </div>

          {/* Description */}
          <div className="form-group">
            <label>Description</label>
            <input
              type="text"
              className="form-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this bot do?"
            />
          </div>

          {/* Variables Section */}
          <div className="form-group">
            <div className="form-label-row">
              <label>Variables</label>
              <button className="btn btn-ghost btn-sm" onClick={addVariable}>
                <Plus size={14} />
                Add Variable
              </button>
            </div>

            {variables.length > 0 && (
              <div className="variable-editor-list">
                {variables.map((v, i) => (
                  <div key={i} className="variable-editor-row">
                    <input
                      type="text"
                      className="form-input form-input-sm"
                      placeholder="Variable name"
                      value={v.name}
                      onChange={(e) =>
                        updateVariable(i, { name: e.target.value.toUpperCase().replace(/\s/g, '_') })
                      }
                    />
                    <input
                      type="text"
                      className="form-input form-input-sm"
                      placeholder="Label"
                      value={v.label}
                      onChange={(e) => updateVariable(i, { label: e.target.value })}
                    />
                    <CustomDropdown
                      className="variable-type-dropdown"
                      value={v.type}
                      onChange={(val) => updateVariable(i, { type: val as BotVariable['type'] })}
                      options={VARIABLE_TYPE_OPTIONS}
                    />
                    <input
                      type="text"
                      className="form-input form-input-sm"
                      placeholder="Default"
                      value={v.default}
                      onChange={(e) => updateVariable(i, { default: e.target.value })}
                    />
                    <label className="variable-required-check">
                      <input
                        type="checkbox"
                        checked={v.required}
                        onChange={(e) => updateVariable(i, { required: e.target.checked })}
                      />
                      Req
                    </label>
                    <button
                      className="btn-icon-sm"
                      onClick={() => copyVariableTag(v.name)}
                      title="Copy tag"
                    >
                      {copied === v.name ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                    <button
                      className="btn-icon-sm btn-danger-ghost"
                      onClick={() => removeVariable(i)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {variables.length > 0 && (
              <div className="variable-insert-hint">
                Click a variable to insert into prompt:
                <div className="variable-insert-tags">
                  {variables
                    .filter((v) => v.name)
                    .map((v) => (
                      <VariableTag
                        key={v.name}
                        name={v.name}
                        onClick={() => insertVariable(v.name)}
                      />
                    ))}
                </div>
              </div>
            )}
          </div>

          {/* Prompt */}
          <div className="form-group">
            <div className="form-label-row">
              <label>Prompt {mode === 'advanced' && '(Advanced)'}</label>
              <div className="bot-prompt-toolbar">
                <span className="bot-prompt-count">{prompt.length} chars</span>
                <button
                  type="button"
                  className="btn-icon-sm"
                  title="Copy prompt"
                  onClick={() => {
                    navigator.clipboard.writeText(prompt)
                    setPromptCopied(true)
                    setTimeout(() => setPromptCopied(false), 1500)
                  }}
                >
                  {promptCopied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </div>
            </div>
            <textarea
              className="form-input bot-prompt-editor"
              rows={mode === 'advanced' ? 15 : 8}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Enter your bot prompt here. Use {{$VARIABLE_NAME$}} to reference variables."
            />
          </div>
        </div>

        <div className="bot-editor-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!name.trim()}>
            <Save size={16} />
            {bot?.id && !bot.id.startsWith('template-') ? 'Update Bot' : 'Create Bot'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ====== Main Page ======
export function BotConfigPage() {
  const [bots, setBots] = useState<BotConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [editingBot, setEditingBot] = useState<BotConfig | null>(null)
  const [showEditor, setShowEditor] = useState(false)

  useEffect(() => {
    fetchBots()
  }, [])

  const fetchBots = async () => {
    setLoading(true)
    try {
      const response = await api.listBots()
      if (response.success && response.data) {
        setBots(response.data as BotConfig[])
      }
    } catch (err) {
      console.error('Error fetching bots:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleEdit = (bot: BotConfig) => {
    setEditingBot(bot)
    setShowEditor(true)
  }

  const handleCreate = () => {
    setEditingBot(null)
    setShowEditor(true)
  }

  const handleSave = async (config: BotConfig) => {
    try {
      if (config.id && !config.id.startsWith('template-')) {
        await api.updateBot(config.id, {
          name: config.name,
          description: config.description,
          prompt: config.prompt,
          variables: config.variables,
          is_active: config.is_active,
        })
      } else {
        await api.createBot({
          name: config.name,
          description: config.description,
          bot_type: config.bot_type,
          prompt: config.prompt,
          variables: config.variables,
        })
      }
      setShowEditor(false)
      setEditingBot(null)
      fetchBots()
    } catch (err) {
      console.error('Error saving bot:', err)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this bot?')) return
    try {
      await api.deleteBot(id)
      fetchBots()
    } catch (err) {
      console.error('Error deleting bot:', err)
    }
  }

  const handleToggle = async (id: string, active: boolean) => {
    try {
      await api.updateBot(id, { is_active: active })
      setBots(bots.map((b) => (b.id === id ? { ...b, is_active: active } : b)))
    } catch (err) {
      console.error('Error toggling bot:', err)
    }
  }

  if (loading) {
    return (
      <div className="bot-config-page">
        <div className="daily-loading">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0' }}>
            <SprintScanLoader size={48} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="bot-config-page">
      <div className="bot-config-header">
        <div>
          <h2 className="bot-config-title">Bot Configuration</h2>
          <p className="bot-config-subtitle">
            Configure AI bots for Slack analysis, report generation, and custom tasks.
          </p>
        </div>
        <button className="btn btn-primary" onClick={handleCreate}>
          <Plus size={16} />
          New Bot
        </button>
      </div>

      {bots.length === 0 ? (
        <div className="daily-empty-state glass-card">
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
            <VelocityLogo variant="icon" size="lg" mark="chevron" showStatusDot={false} style={{ opacity: 0.25 }} />
          </div>
          <Bot size={48} />
          <h3>No Bots Configured</h3>
          <p>Create a bot from a template or build your own custom bot.</p>
          <button className="btn btn-primary" onClick={handleCreate}>
            <Plus size={16} />
            Create Bot
          </button>
        </div>
      ) : (
        <div className="bot-grid">
          {bots.map((bot) => (
            <BotCard
              key={bot.id}
              bot={bot}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onToggle={handleToggle}
            />
          ))}
        </div>
      )}

      {showEditor && (
        <BotEditor
          bot={editingBot}
          onSave={handleSave}
          onClose={() => {
            setShowEditor(false)
            setEditingBot(null)
          }}
        />
      )}
    </div>
  )
}
