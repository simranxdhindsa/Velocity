package database

import (
	"context"
	"encoding/json"
	"time"
)

// ── Models ────────────────────────────────────────────────────────────────────

type DayTrackEntry struct {
	ID            string     `json:"id"`
	UserID        string     `json:"user_id"`
	EntryDate     string     `json:"entry_date"` // YYYY-MM-DD
	Name          string     `json:"name"`
	Category      string     `json:"category"`
	StartTime     string     `json:"start_time"`
	EndTime       string     `json:"end_time"`
	DurationMins  *int       `json:"duration_mins"`
	Notes         string     `json:"notes"`
	Status        string     `json:"status"`
	ParentEntryID *string    `json:"parent_entry_id"`
	EntrySource   string     `json:"entry_source"` // manual | slack | youtrack_qa | youtrack_created
	ExternalRef   string     `json:"external_ref"` // Slack TS or YouTrack issue ID
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// DayTrackSlackConfig holds per-user Slack auto-logging settings.
type DayTrackSlackConfig struct {
	ID              string           `json:"id"`
	UserID          string           `json:"user_id"`
	ChannelID       string           `json:"channel_id"`
	ChannelName     string           `json:"channel_name"`
	SlackUserID     string           `json:"slack_user_id"`
	KeywordRules    []DayTrackKWRule `json:"keyword_rules"`
	Enabled         bool             `json:"enabled"`
	LastScannedTS   string           `json:"last_scanned_ts"`
	DestChannelID   string           `json:"dest_channel_id"`
	DestChannelName string           `json:"dest_channel_name"`
	Timezone        string           `json:"timezone"` // IANA tz name, e.g. "Asia/Kolkata"
}

// DayTrackKWRule is a single keyword → rule_type mapping.
type DayTrackKWRule struct {
	Category string   `json:"category"`
	Keywords []string `json:"keywords"`
	RuleType string   `json:"rule_type"` // sign_in | sign_off | break_start | break_end
}

type DayTrackPlanned struct {
	ID            string    `json:"id"`
	UserID        string    `json:"user_id"`
	EntryDate     string    `json:"entry_date"`
	Name          string    `json:"name"`
	Category      string    `json:"category"`
	ScheduledTime string    `json:"scheduled_time"`
	StartTime     string    `json:"start_time"`
	EndTime       string    `json:"end_time"`
	WhenType      string    `json:"when_type"` // today | tomorrow
	Notes         string    `json:"notes"`
	Status        string    `json:"status"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type DayTrackRepository struct{}

func NewDayTrackRepository() *DayTrackRepository { return &DayTrackRepository{} }

// ── Entries ───────────────────────────────────────────────────────────────────

func (r *DayTrackRepository) GetEntries(ctx context.Context, userID, date string) ([]DayTrackEntry, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx,
		`SELECT id, user_id, entry_date::text, name, category, COALESCE(start_time,''), COALESCE(end_time,''),
		        duration_mins, COALESCE(notes,''), status, parent_entry_id,
		        COALESCE(entry_source,'manual'), COALESCE(external_ref,''),
		        created_at, updated_at
		 FROM daytrack_entries WHERE user_id=$1 AND entry_date=$2::date ORDER BY end_time DESC NULLS FIRST, start_time DESC NULLS LAST, created_at DESC`,
		userID, date)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var entries []DayTrackEntry
	for rows.Next() {
		var e DayTrackEntry
		if err := rows.Scan(&e.ID, &e.UserID, &e.EntryDate, &e.Name, &e.Category,
			&e.StartTime, &e.EndTime, &e.DurationMins, &e.Notes, &e.Status, &e.ParentEntryID,
			&e.EntrySource, &e.ExternalRef,
			&e.CreatedAt, &e.UpdatedAt); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	if entries == nil {
		entries = []DayTrackEntry{}
	}
	return entries, nil
}

func (r *DayTrackRepository) CreateEntry(ctx context.Context, userID, date, name, category, startTime, endTime string, durationMins *int, notes, status string, parentEntryID *string) (*DayTrackEntry, error) {
	return r.CreateEntrySourced(ctx, userID, date, name, category, startTime, endTime, durationMins, notes, status, parentEntryID, "manual", "")
}

func (r *DayTrackRepository) CreateEntrySourced(ctx context.Context, userID, date, name, category, startTime, endTime string, durationMins *int, notes, status string, parentEntryID *string, entrySource, externalRef string) (*DayTrackEntry, error) {
	pool := GetPool()
	if entrySource == "" {
		entrySource = "manual"
	}
	var e DayTrackEntry
	err := pool.QueryRow(ctx,
		`INSERT INTO daytrack_entries (user_id, entry_date, name, category, start_time, end_time, duration_mins, notes, status, parent_entry_id, entry_source, external_ref)
		 VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		 ON CONFLICT (user_id, external_ref) WHERE external_ref IS NOT NULL AND external_ref != ''
		 DO NOTHING
		 RETURNING id, user_id, entry_date::text, name, category, COALESCE(start_time,''), COALESCE(end_time,''),
		           duration_mins, COALESCE(notes,''), status, parent_entry_id,
		           COALESCE(entry_source,'manual'), COALESCE(external_ref,''),
		           created_at, updated_at`,
		userID, date, name, category, nullStr(startTime), nullStr(endTime), durationMins, notes, status, parentEntryID, entrySource, nullStr(externalRef),
	).Scan(&e.ID, &e.UserID, &e.EntryDate, &e.Name, &e.Category,
		&e.StartTime, &e.EndTime, &e.DurationMins, &e.Notes, &e.Status, &e.ParentEntryID,
		&e.EntrySource, &e.ExternalRef,
		&e.CreatedAt, &e.UpdatedAt)
	// pgx returns pgx.ErrNoRows when DO NOTHING skips the insert — treat as success
	if err != nil && err.Error() == "no rows in result set" {
		return nil, nil
	}
	return &e, err
}

func (r *DayTrackRepository) UpdateEntry(ctx context.Context, id, userID, name, category, startTime, endTime string, durationMins *int, notes, status string) (*DayTrackEntry, error) {
	pool := GetPool()
	var e DayTrackEntry
	err := pool.QueryRow(ctx,
		`UPDATE daytrack_entries SET name=$3, category=$4, start_time=$5, end_time=$6, duration_mins=$7, notes=$8, status=$9, updated_at=NOW()
		 WHERE id=$1 AND user_id=$2
		 RETURNING id, user_id, entry_date::text, name, category, COALESCE(start_time,''), COALESCE(end_time,''),
		           duration_mins, COALESCE(notes,''), status, parent_entry_id,
		           COALESCE(entry_source,'manual'), COALESCE(external_ref,''),
		           created_at, updated_at`,
		id, userID, name, category, nullStr(startTime), nullStr(endTime), durationMins, notes, status,
	).Scan(&e.ID, &e.UserID, &e.EntryDate, &e.Name, &e.Category,
		&e.StartTime, &e.EndTime, &e.DurationMins, &e.Notes, &e.Status, &e.ParentEntryID,
		&e.EntrySource, &e.ExternalRef,
		&e.CreatedAt, &e.UpdatedAt)
	return &e, err
}

func (r *DayTrackRepository) DeleteEntry(ctx context.Context, id, userID string) error {
	pool := GetPool()
	_, err := pool.Exec(ctx, `DELETE FROM daytrack_entries WHERE id=$1 AND user_id=$2`, id, userID)
	return err
}

func (r *DayTrackRepository) GetEntryByID(ctx context.Context, id, userID string) (*DayTrackEntry, error) {
	pool := GetPool()
	var e DayTrackEntry
	err := pool.QueryRow(ctx,
		`SELECT id, user_id, entry_date::text, name, category, COALESCE(start_time,''), COALESCE(end_time,''),
		        duration_mins, COALESCE(notes,''), status, parent_entry_id,
		        COALESCE(entry_source,'manual'), COALESCE(external_ref,''),
		        created_at, updated_at
		 FROM daytrack_entries WHERE id=$1 AND user_id=$2`,
		id, userID,
	).Scan(&e.ID, &e.UserID, &e.EntryDate, &e.Name, &e.Category,
		&e.StartTime, &e.EndTime, &e.DurationMins, &e.Notes, &e.Status, &e.ParentEntryID,
		&e.EntrySource, &e.ExternalRef,
		&e.CreatedAt, &e.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// ── Planned ───────────────────────────────────────────────────────────────────

func (r *DayTrackRepository) GetPlanned(ctx context.Context, userID, date string) ([]DayTrackPlanned, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx,
		`SELECT id, user_id, entry_date::text, name, category, COALESCE(scheduled_time,''),
		        COALESCE(start_time,''), COALESCE(end_time,''),
		        when_type, COALESCE(notes,''), status, created_at, updated_at
		 FROM daytrack_planned WHERE user_id=$1 AND entry_date=$2::date ORDER BY created_at DESC`,
		userID, date)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []DayTrackPlanned
	for rows.Next() {
		var p DayTrackPlanned
		if err := rows.Scan(&p.ID, &p.UserID, &p.EntryDate, &p.Name, &p.Category,
			&p.ScheduledTime, &p.StartTime, &p.EndTime, &p.WhenType, &p.Notes, &p.Status, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, p)
	}
	if items == nil {
		items = []DayTrackPlanned{}
	}
	return items, nil
}

func (r *DayTrackRepository) CreatePlanned(ctx context.Context, userID, date, name, category, scheduledTime, startTime, endTime, whenType, notes, status string) (*DayTrackPlanned, error) {
	pool := GetPool()
	var p DayTrackPlanned
	err := pool.QueryRow(ctx,
		`INSERT INTO daytrack_planned (user_id, entry_date, name, category, scheduled_time, start_time, end_time, when_type, notes, status)
		 VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10)
		 RETURNING id, user_id, entry_date::text, name, category, COALESCE(scheduled_time,''),
		           COALESCE(start_time,''), COALESCE(end_time,''), when_type, COALESCE(notes,''), status, created_at, updated_at`,
		userID, date, name, category, nullStr(scheduledTime), nullStr(startTime), nullStr(endTime), whenType, notes, status,
	).Scan(&p.ID, &p.UserID, &p.EntryDate, &p.Name, &p.Category,
		&p.ScheduledTime, &p.StartTime, &p.EndTime, &p.WhenType, &p.Notes, &p.Status, &p.CreatedAt, &p.UpdatedAt)
	return &p, err
}

func (r *DayTrackRepository) UpdatePlanned(ctx context.Context, id, userID, name, category, scheduledTime, startTime, endTime, whenType, notes, status string) (*DayTrackPlanned, error) {
	pool := GetPool()
	var p DayTrackPlanned
	err := pool.QueryRow(ctx,
		`UPDATE daytrack_planned SET name=$3, category=$4, scheduled_time=$5, start_time=$6, end_time=$7, when_type=$8, notes=$9, status=$10, updated_at=NOW()
		 WHERE id=$1 AND user_id=$2
		 RETURNING id, user_id, entry_date::text, name, category, COALESCE(scheduled_time,''),
		           COALESCE(start_time,''), COALESCE(end_time,''), when_type, COALESCE(notes,''), status, created_at, updated_at`,
		id, userID, name, category, nullStr(scheduledTime), nullStr(startTime), nullStr(endTime), whenType, notes, status,
	).Scan(&p.ID, &p.UserID, &p.EntryDate, &p.Name, &p.Category,
		&p.ScheduledTime, &p.StartTime, &p.EndTime, &p.WhenType, &p.Notes, &p.Status, &p.CreatedAt, &p.UpdatedAt)
	return &p, err
}

func (r *DayTrackRepository) DeletePlanned(ctx context.Context, id, userID string) error {
	pool := GetPool()
	_, err := pool.Exec(ctx, `DELETE FROM daytrack_planned WHERE id=$1 AND user_id=$2`, id, userID)
	return err
}

// ── Range export ─────────────────────────────────────────────────────────────

func (r *DayTrackRepository) GetEntriesRange(ctx context.Context, userID, startDate, endDate string) ([]DayTrackEntry, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx,
		`SELECT id, user_id, entry_date::text, name, category, COALESCE(start_time,''), COALESCE(end_time,''),
		        duration_mins, COALESCE(notes,''), status, parent_entry_id,
		        COALESCE(entry_source,'manual'), COALESCE(external_ref,''),
		        created_at, updated_at
		 FROM daytrack_entries
		 WHERE user_id=$1 AND entry_date BETWEEN $2::date AND $3::date
		 ORDER BY entry_date ASC, created_at ASC`,
		userID, startDate, endDate)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var entries []DayTrackEntry
	for rows.Next() {
		var e DayTrackEntry
		if err := rows.Scan(&e.ID, &e.UserID, &e.EntryDate, &e.Name, &e.Category,
			&e.StartTime, &e.EndTime, &e.DurationMins, &e.Notes, &e.Status, &e.ParentEntryID,
			&e.EntrySource, &e.ExternalRef,
			&e.CreatedAt, &e.UpdatedAt); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	if entries == nil {
		entries = []DayTrackEntry{}
	}
	return entries, nil
}

// ── Suggestions ──────────────────────────────────────────────────────────────

func (r *DayTrackRepository) GetSuggestions(ctx context.Context, userID string) ([]string, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx,
		`SELECT DISTINCT name FROM daytrack_entries WHERE user_id=$1 ORDER BY name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		names = append(names, n)
	}
	if names == nil {
		names = []string{}
	}
	return names, nil
}

// ── Categories ────────────────────────────────────────────────────────────────

func (r *DayTrackRepository) GetCategories(ctx context.Context, userID string) ([]string, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx,
		`SELECT name FROM daytrack_categories WHERE user_id=$1 ORDER BY position, name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cats []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		cats = append(cats, name)
	}
	return cats, nil
}

func (r *DayTrackRepository) AddCategory(ctx context.Context, userID, name string) error {
	pool := GetPool()
	// Get next position first to avoid $1 type ambiguity in a single query
	var pos int
	err := pool.QueryRow(ctx,
		`SELECT COALESCE(MAX(position),0)+1 FROM daytrack_categories WHERE user_id=$1`, userID).Scan(&pos)
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx,
		`INSERT INTO daytrack_categories (user_id, name, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		userID, name, pos)
	return err
}

func (r *DayTrackRepository) DeleteCategory(ctx context.Context, userID, name string) error {
	pool := GetPool()
	_, err := pool.Exec(ctx, `DELETE FROM daytrack_categories WHERE user_id=$1 AND name=$2`, userID, name)
	return err
}

// nullStr returns nil if s is empty, else &s — for nullable TEXT columns
func nullStr(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

// ── DayTrack Slack config ─────────────────────────────────────────────────────

func (r *DayTrackRepository) GetSlackConfig(ctx context.Context, userID string) (*DayTrackSlackConfig, error) {
	pool := GetPool()
	var cfg DayTrackSlackConfig
	var rulesJSON []byte
	err := pool.QueryRow(ctx,
		`SELECT id, user_id, channel_id, channel_name, slack_user_id, keyword_rules, enabled, last_scanned_ts,
		        COALESCE(dest_channel_id,''), COALESCE(dest_channel_name,''), COALESCE(timezone,'Asia/Kolkata')
		 FROM daytrack_slack_config WHERE user_id=$1`, userID,
	).Scan(&cfg.ID, &cfg.UserID, &cfg.ChannelID, &cfg.ChannelName, &cfg.SlackUserID,
		&rulesJSON, &cfg.Enabled, &cfg.LastScannedTS, &cfg.DestChannelID, &cfg.DestChannelName, &cfg.Timezone)
	if err != nil {
		return nil, err
	}
	if len(rulesJSON) > 0 {
		_ = json.Unmarshal(rulesJSON, &cfg.KeywordRules)
	}
	return &cfg, nil
}

func (r *DayTrackRepository) UpsertSlackConfig(ctx context.Context, cfg *DayTrackSlackConfig) error {
	pool := GetPool()
	rulesJSON, err := json.Marshal(cfg.KeywordRules)
	if err != nil {
		return err
	}
	tz := cfg.Timezone
	if tz == "" {
		tz = "Asia/Kolkata"
	}
	_, err = pool.Exec(ctx,
		`INSERT INTO daytrack_slack_config (user_id, channel_id, channel_name, slack_user_id, keyword_rules, enabled, dest_channel_id, dest_channel_name, timezone, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
		 ON CONFLICT(user_id) DO UPDATE SET
		   channel_id=$2, channel_name=$3, slack_user_id=$4,
		   keyword_rules=$5, enabled=$6, dest_channel_id=$7, dest_channel_name=$8, timezone=$9, updated_at=NOW()`,
		cfg.UserID, cfg.ChannelID, cfg.ChannelName, cfg.SlackUserID, rulesJSON, cfg.Enabled,
		cfg.DestChannelID, cfg.DestChannelName, tz)
	return err
}

// GetAllEnabledSlackConfigs returns all configs that have a channel and slack_user_id set.
// Used by the background scanner. Joins with slack_integrations to get the bot token.
type SlackScanConfig struct {
	UserID        string
	ChannelID     string
	SlackUserID   string
	LastScannedTS string
	BotToken      string
	KeywordRules  []DayTrackKWRule
	Timezone      string
}

func (r *DayTrackRepository) GetAllEnabledSlackConfigs(ctx context.Context) ([]SlackScanConfig, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx,
		`SELECT dsc.user_id, dsc.channel_id, dsc.slack_user_id, dsc.last_scanned_ts,
		        si.bot_token, dsc.keyword_rules, COALESCE(dsc.timezone,'Asia/Kolkata')
		 FROM daytrack_slack_config dsc
		 JOIN slack_integrations si ON si.user_id = dsc.user_id
		 WHERE dsc.enabled = true
		   AND dsc.channel_id != ''
		   AND dsc.slack_user_id != ''
		   AND si.connected = true`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SlackScanConfig
	for rows.Next() {
		var c SlackScanConfig
		var rulesJSON []byte
		if err := rows.Scan(&c.UserID, &c.ChannelID, &c.SlackUserID, &c.LastScannedTS, &c.BotToken, &rulesJSON, &c.Timezone); err != nil {
			continue
		}
		if len(rulesJSON) > 0 {
			_ = json.Unmarshal(rulesJSON, &c.KeywordRules)
		}
		out = append(out, c)
	}
	return out, nil
}

func (r *DayTrackRepository) UpdateSlackConfigLastScanned(ctx context.Context, userID, ts string) error {
	pool := GetPool()
	_, err := pool.Exec(ctx,
		`UPDATE daytrack_slack_config SET last_scanned_ts=$2, updated_at=NOW() WHERE user_id=$1`,
		userID, ts)
	return err
}

func (r *DayTrackRepository) ResetSlackConfigLastScanned(ctx context.Context, userID string) error {
	pool := GetPool()
	_, err := pool.Exec(ctx,
		`UPDATE daytrack_slack_config SET last_scanned_ts='', updated_at=NOW() WHERE user_id=$1`,
		userID)
	return err
}

// GetOpenBreakEntry returns the most recent unclosed slack break entry for today.
func (r *DayTrackRepository) GetOpenBreakEntry(ctx context.Context, userID, date string) (*DayTrackEntry, error) {
	pool := GetPool()
	var e DayTrackEntry
	err := pool.QueryRow(ctx,
		`SELECT id, user_id, entry_date::text, name, category, COALESCE(start_time,''), COALESCE(end_time,''),
		        duration_mins, COALESCE(notes,''), status, parent_entry_id,
		        COALESCE(entry_source,'manual'), COALESCE(external_ref,''),
		        created_at, updated_at
		 FROM daytrack_entries
		 WHERE user_id=$1 AND entry_date=$2::date AND entry_source='slack'
		   AND (end_time IS NULL OR end_time='')
		 ORDER BY created_at DESC LIMIT 1`,
		userID, date,
	).Scan(&e.ID, &e.UserID, &e.EntryDate, &e.Name, &e.Category,
		&e.StartTime, &e.EndTime, &e.DurationMins, &e.Notes, &e.Status, &e.ParentEntryID,
		&e.EntrySource, &e.ExternalRef,
		&e.CreatedAt, &e.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// EntryExistsByExternalRef checks if a Slack-sourced entry with this TS/ref already exists.
func (r *DayTrackRepository) EntryExistsByExternalRef(ctx context.Context, userID, ref string) (bool, error) {
	pool := GetPool()
	var exists bool
	err := pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM daytrack_entries WHERE user_id=$1 AND external_ref=$2)`,
		userID, ref).Scan(&exists)
	return exists, err
}

