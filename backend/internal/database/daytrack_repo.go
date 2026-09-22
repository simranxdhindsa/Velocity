package database

import (
	"context"
	"encoding/json"
	"time"
)

// ── Models ────────────────────────────────────────────────────────────────────

type DayTrackEntry struct {
	ID              string    `json:"id"`
	UserID          string    `json:"user_id"`
	EntryDate       string    `json:"entry_date"` // YYYY-MM-DD
	Name            string    `json:"name"`
	Category        string    `json:"category"`
	StartTime       string    `json:"start_time"`
	EndTime         string    `json:"end_time"`
	DurationMins    *int      `json:"duration_mins"`
	Notes           string    `json:"notes"`
	Status          string    `json:"status"`
	ParentEntryID   *string   `json:"parent_entry_id"`
	EntrySource     string    `json:"entry_source"`                // manual | slack | youtrack_qa | youtrack_created
	ExternalRef     string    `json:"external_ref"`                // Slack TS or YouTrack issue ID
	YoutrackIssueID *string   `json:"youtrack_issue_id,omitempty"` // set for entry_source='youtrack' rows; used to prune entries whose ticket was deleted
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
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
	Timezone        string           `json:"timezone"`          // IANA tz name, e.g. "Asia/Kolkata"
	AutoSendEnabled bool             `json:"auto_send_enabled"` // auto-post today's update at the fixed daily time; time itself is not user-configurable
}

// DayTrackKWRule is a single keyword → rule_type mapping.
type DayTrackKWRule struct {
	Category string   `json:"category"`
	Keywords []string `json:"keywords"`
	RuleType string   `json:"rule_type"` // sign_in | sign_off | break_start | break_end
}

type DayTrackPlanned struct {
	ID              string    `json:"id"`
	UserID          string    `json:"user_id"`
	EntryDate       string    `json:"entry_date"`
	Name            string    `json:"name"`
	Category        string    `json:"category"`
	ScheduledTime   string    `json:"scheduled_time"`
	StartTime       string    `json:"start_time"`
	EndTime         string    `json:"end_time"`
	WhenType        string    `json:"when_type"` // today | tomorrow
	Notes           string    `json:"notes"`
	Status          string    `json:"status"`
	EntrySource     string    `json:"entry_source"`                // manual | youtrack — preserved across carry-forward
	ExternalRef     string    `json:"external_ref"`                // preserved so a re-started item still dedupes against its origin
	YoutrackIssueID *string   `json:"youtrack_issue_id,omitempty"` // set when carried from a youtrack-sourced entry
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type DayTrackRepository struct{}

func NewDayTrackRepository() *DayTrackRepository { return &DayTrackRepository{} }

// ── Entries ───────────────────────────────────────────────────────────────────

func (r *DayTrackRepository) GetEntries(ctx context.Context, userID, date string) ([]DayTrackEntry, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx,
		`SELECT id, user_id, entry_date::text, name, category, COALESCE(start_time,''), COALESCE(end_time,''),
		        duration_mins, COALESCE(notes,''), status, parent_entry_id,
		        COALESCE(entry_source,'manual'), COALESCE(external_ref,''), youtrack_issue_id,
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
			&e.EntrySource, &e.ExternalRef, &e.YoutrackIssueID,
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

// SetYoutrackIssueID stamps the source YouTrack issue ID onto a just-created entry so
// it can later be pruned (see PruneEntriesForDeletedIssue) if that ticket gets deleted.
func (r *DayTrackRepository) SetYoutrackIssueID(ctx context.Context, entryID, issueID string) error {
	pool := GetPool()
	_, err := pool.Exec(ctx, `UPDATE daytrack_entries SET youtrack_issue_id = $1 WHERE id = $2`, issueID, entryID)
	return err
}

// YouTrackLinkedEntry is one (user, issue) pair pulled from today's YouTrack-sourced entries,
// used to opportunistically re-check ticket existence when any YouTrack webhook fires.
type YouTrackLinkedEntry struct {
	UserID  string
	IssueID string
}

// TodayYouTrackLinkedIssues returns the distinct (user_id, youtrack_issue_id) pairs for every
// YouTrack-sourced DayTrack entry dated `date`.
func (r *DayTrackRepository) TodayYouTrackLinkedIssues(ctx context.Context, date string) ([]YouTrackLinkedEntry, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx,
		`SELECT DISTINCT user_id, youtrack_issue_id FROM daytrack_entries
		 WHERE entry_date = $1 AND entry_source = 'youtrack'
		   AND youtrack_issue_id IS NOT NULL AND youtrack_issue_id != ''`, date)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []YouTrackLinkedEntry
	for rows.Next() {
		var e YouTrackLinkedEntry
		if err := rows.Scan(&e.UserID, &e.IssueID); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// PruneEntriesForDeletedIssue deletes every DayTrack entry (any user, any date) that was
// auto-logged from a YouTrack ticket confirmed deleted, plus the ticket's own state-log
// history. Only call this once existence has been positively confirmed (404), never on an
// ambiguous/failed lookup — the caller is responsible for that distinction.
func (r *DayTrackRepository) PruneEntriesForDeletedIssue(ctx context.Context, issueID string) error {
	pool := GetPool()
	if _, err := pool.Exec(ctx, `DELETE FROM daytrack_entries WHERE youtrack_issue_id = $1`, issueID); err != nil {
		return err
	}
	_, err := pool.Exec(ctx, `DELETE FROM issue_state_log WHERE issue_id = $1`, issueID)
	return err
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
		        when_type, COALESCE(notes,''), status,
		        COALESCE(entry_source,'manual'), COALESCE(external_ref,''), youtrack_issue_id,
		        created_at, updated_at
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
			&p.ScheduledTime, &p.StartTime, &p.EndTime, &p.WhenType, &p.Notes, &p.Status,
			&p.EntrySource, &p.ExternalRef, &p.YoutrackIssueID,
			&p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, p)
	}
	if items == nil {
		items = []DayTrackPlanned{}
	}
	return items, nil
}

func (r *DayTrackRepository) CreatePlanned(ctx context.Context, userID, date, name, category, scheduledTime, startTime, endTime, whenType, notes, status, entrySource, externalRef string, youtrackIssueID *string) (*DayTrackPlanned, error) {
	pool := GetPool()
	if entrySource == "" {
		entrySource = "manual"
	}
	var p DayTrackPlanned
	err := pool.QueryRow(ctx,
		`INSERT INTO daytrack_planned (user_id, entry_date, name, category, scheduled_time, start_time, end_time, when_type, notes, status, entry_source, external_ref, youtrack_issue_id)
		 VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		 ON CONFLICT (user_id, external_ref) WHERE external_ref IS NOT NULL AND external_ref != ''
		 DO NOTHING
		 RETURNING id, user_id, entry_date::text, name, category, COALESCE(scheduled_time,''),
		           COALESCE(start_time,''), COALESCE(end_time,''), when_type, COALESCE(notes,''), status,
		           COALESCE(entry_source,'manual'), COALESCE(external_ref,''), youtrack_issue_id, created_at, updated_at`,
		userID, date, name, category, nullStr(scheduledTime), nullStr(startTime), nullStr(endTime), whenType, notes, status,
		entrySource, nullStr(externalRef), youtrackIssueID,
	).Scan(&p.ID, &p.UserID, &p.EntryDate, &p.Name, &p.Category,
		&p.ScheduledTime, &p.StartTime, &p.EndTime, &p.WhenType, &p.Notes, &p.Status,
		&p.EntrySource, &p.ExternalRef, &p.YoutrackIssueID, &p.CreatedAt, &p.UpdatedAt)
	// pgx returns "no rows in result set" when DO NOTHING skips the insert (a dedup
	// hit, e.g. the same YouTrack ticket already pulled in today) — treat as success.
	if err != nil && err.Error() == "no rows in result set" {
		return nil, nil
	}
	return &p, err
}

func (r *DayTrackRepository) UpdatePlanned(ctx context.Context, id, userID, name, category, scheduledTime, startTime, endTime, whenType, notes, status string) (*DayTrackPlanned, error) {
	pool := GetPool()
	var p DayTrackPlanned
	err := pool.QueryRow(ctx,
		`UPDATE daytrack_planned SET name=$3, category=$4, scheduled_time=$5, start_time=$6, end_time=$7, when_type=$8, notes=$9, status=$10, updated_at=NOW()
		 WHERE id=$1 AND user_id=$2
		 RETURNING id, user_id, entry_date::text, name, category, COALESCE(scheduled_time,''),
		           COALESCE(start_time,''), COALESCE(end_time,''), when_type, COALESCE(notes,''), status,
		           COALESCE(entry_source,'manual'), COALESCE(external_ref,''), youtrack_issue_id, created_at, updated_at`,
		id, userID, name, category, nullStr(scheduledTime), nullStr(startTime), nullStr(endTime), whenType, notes, status,
	).Scan(&p.ID, &p.UserID, &p.EntryDate, &p.Name, &p.Category,
		&p.ScheduledTime, &p.StartTime, &p.EndTime, &p.WhenType, &p.Notes, &p.Status,
		&p.EntrySource, &p.ExternalRef, &p.YoutrackIssueID, &p.CreatedAt, &p.UpdatedAt)
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
		        COALESCE(entry_source,'manual'), COALESCE(external_ref,''), youtrack_issue_id,
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
			&e.EntrySource, &e.ExternalRef, &e.YoutrackIssueID,
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
		        COALESCE(dest_channel_id,''), COALESCE(dest_channel_name,''), COALESCE(timezone,'Asia/Kolkata'),
		        auto_send_enabled
		 FROM daytrack_slack_config WHERE user_id=$1`, userID,
	).Scan(&cfg.ID, &cfg.UserID, &cfg.ChannelID, &cfg.ChannelName, &cfg.SlackUserID,
		&rulesJSON, &cfg.Enabled, &cfg.LastScannedTS, &cfg.DestChannelID, &cfg.DestChannelName, &cfg.Timezone,
		&cfg.AutoSendEnabled)
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
		`INSERT INTO daytrack_slack_config (user_id, channel_id, channel_name, slack_user_id, keyword_rules, enabled, dest_channel_id, dest_channel_name, timezone, auto_send_enabled, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
		 ON CONFLICT(user_id) DO UPDATE SET
		   channel_id=$2, channel_name=$3, slack_user_id=$4,
		   keyword_rules=$5, enabled=$6, dest_channel_id=$7, dest_channel_name=$8, timezone=$9, auto_send_enabled=$10, updated_at=NOW()`,
		cfg.UserID, cfg.ChannelID, cfg.ChannelName, cfg.SlackUserID, rulesJSON, cfg.Enabled,
		cfg.DestChannelID, cfg.DestChannelName, tz, cfg.AutoSendEnabled)
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

// AutoSendConfig is a user opted into the daily auto-send-to-Slack job.
type AutoSendConfig struct {
	UserID        string
	DestChannelID string
}

// GetAllAutoSendConfigs returns every user with auto-send turned on, a destination channel
// set, and a connected Slack integration to post through. Used by the daily scheduler.
func (r *DayTrackRepository) GetAllAutoSendConfigs(ctx context.Context) ([]AutoSendConfig, error) {
	pool := GetPool()
	rows, err := pool.Query(ctx,
		`SELECT dsc.user_id, dsc.dest_channel_id
		 FROM daytrack_slack_config dsc
		 JOIN slack_integrations si ON si.user_id = dsc.user_id
		 WHERE dsc.auto_send_enabled = true
		   AND dsc.dest_channel_id != ''
		   AND si.connected = true`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AutoSendConfig
	for rows.Next() {
		var c AutoSendConfig
		if err := rows.Scan(&c.UserID, &c.DestChannelID); err != nil {
			continue
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

// ── Daily Slack post idempotency ────────────────────────────────────────────────
// "Post to Slack" posts once per (user, date) and edits that same message in place on
// every later click for the same date, instead of spamming a new message each time.

type DayTrackDailyPost struct {
	UserID    string    `json:"user_id"`
	EntryDate string    `json:"entry_date"`
	ChannelID string    `json:"channel_id"`
	SlackTS   string    `json:"slack_ts"`
	PostedAt  time.Time `json:"posted_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// GetDailyPost returns the existing post record for this user+date, or nil if never posted.
func (r *DayTrackRepository) GetDailyPost(ctx context.Context, userID, date string) (*DayTrackDailyPost, error) {
	pool := GetPool()
	var p DayTrackDailyPost
	err := pool.QueryRow(ctx, `
		SELECT user_id, entry_date::text, channel_id, slack_ts, posted_at, updated_at
		FROM daytrack_daily_posts WHERE user_id=$1 AND entry_date=$2::date`,
		userID, date,
	).Scan(&p.UserID, &p.EntryDate, &p.ChannelID, &p.SlackTS, &p.PostedAt, &p.UpdatedAt)
	if err != nil {
		if err.Error() == "no rows in result set" {
			return nil, nil
		}
		return nil, err
	}
	return &p, nil
}

// UpsertDailyPost records a fresh post (first click of the day) or bumps updated_at for
// an edit-in-place (later clicks the same day). channelID/slackTS are only meaningful on
// first insert — ON CONFLICT intentionally leaves them untouched so the stored ts always
// still points at the original message we're editing.
func (r *DayTrackRepository) UpsertDailyPost(ctx context.Context, userID, date, channelID, slackTS string) error {
	pool := GetPool()
	_, err := pool.Exec(ctx, `
		INSERT INTO daytrack_daily_posts (user_id, entry_date, channel_id, slack_ts)
		VALUES ($1, $2::date, $3, $4)
		ON CONFLICT (user_id, entry_date) DO UPDATE SET updated_at = NOW()`,
		userID, date, channelID, slackTS)
	return err
}

// DeleteDailyPost removes the post record for this user+date, so a later "Post to Slack"
// starts a fresh message instead of trying to edit the one that was just deleted.
func (r *DayTrackRepository) DeleteDailyPost(ctx context.Context, userID, date string) error {
	pool := GetPool()
	_, err := pool.Exec(ctx,
		`DELETE FROM daytrack_daily_posts WHERE user_id=$1 AND entry_date=$2::date`,
		userID, date)
	return err
}
