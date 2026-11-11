package database

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/logging"
	"github.com/jackc/pgx/v5"
)

// AppLogRepository stores backend log lines (warnings and errors) in app_logs. It implements
// logging.Sink.
type AppLogRepository struct{}

func NewAppLogRepository() *AppLogRepository { return &AppLogRepository{} }

const appLogMaxAttrsBytes = 8 * 1024

// AppLog is one stored log line.
type AppLog struct {
	ID        int64          `json:"id"`
	CreatedAt time.Time      `json:"created_at"`
	Level     string         `json:"level"`
	Message   string         `json:"message"`
	RequestID string         `json:"request_id"`
	UserID    string         `json:"user_id"`
	Route     string         `json:"route"`
	Job       string         `json:"job"`
	Attrs     map[string]any `json:"attrs"`
}

// AppLogFilter narrows a List call. Zero values mean "no filter".
type AppLogFilter struct {
	MinLevel  string // debug | info | warn | error
	Q         string
	RequestID string
	UserID    string
	Since     *time.Time
	Until     *time.Time
	Limit     int
	BeforeID  int64
}

var appLogLevels = []string{"DEBUG", "INFO", "WARN", "ERROR"}

// AppLogLevelsFrom returns the level names at or above min, or nil when min is not a level.
func AppLogLevelsFrom(min string) []string {
	for i, l := range appLogLevels {
		if strings.EqualFold(l, min) {
			return appLogLevels[i:]
		}
	}
	return nil
}

// AppLogClampLimit applies the default (100) and maximum (500) page size.
func AppLogClampLimit(n int) int {
	if n <= 0 {
		return 100
	}
	if n > 500 {
		return 500
	}
	return n
}

func appLogAttrsJSON(attrs map[string]any) []byte {
	if len(attrs) == 0 {
		return []byte("{}")
	}
	b, err := json.Marshal(attrs)
	if err != nil || len(b) > appLogMaxAttrsBytes {
		note := map[string]any{"truncated": true}
		if err != nil {
			note["marshal_error"] = err.Error()
		} else {
			note["original_bytes"] = len(b)
			note["preview"] = strings.ToValidUTF8(string(b[:appLogMaxAttrsBytes/2]), "")
		}
		b, _ = json.Marshal(note)
	}
	return b
}

func (r *AppLogRepository) InsertLogs(ctx context.Context, recs []logging.Record) error {
	pool := GetPool()
	if pool == nil || len(recs) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, rec := range recs {
		at := rec.Time
		if at.IsZero() {
			at = time.Now()
		}
		batch.Queue(`INSERT INTO app_logs (created_at, level, message, request_id, user_id, route, job, attrs)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
			at, rec.Level, strings.ToValidUTF8(strings.ReplaceAll(rec.Message, "\x00", ""), ""),
			rec.RequestID, rec.UserID, rec.Route, rec.Job,
			strings.ReplaceAll(string(appLogAttrsJSON(rec.Attrs)), `\u0000`, ""))
	}
	br := pool.SendBatch(ctx, batch)
	defer br.Close()
	for range recs {
		if _, err := br.Exec(); err != nil {
			return err
		}
	}
	return nil
}

func (r *AppLogRepository) PruneLogs(ctx context.Context, olderThan time.Duration) (int64, error) {
	pool := GetPool()
	if pool == nil {
		return 0, nil
	}
	tag, err := pool.Exec(ctx, `DELETE FROM app_logs WHERE created_at < $1`, time.Now().Add(-olderThan))
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func escapeLike(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	return strings.ReplaceAll(s, `_`, `\_`)
}

// List returns log lines newest first (by id).
func (r *AppLogRepository) List(ctx context.Context, f AppLogFilter) ([]AppLog, error) {
	pool := GetPool()
	if pool == nil {
		return nil, errors.New("database not connected")
	}
	var where []string
	var args []any
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(cond, len(args)))
	}
	if lv := AppLogLevelsFrom(f.MinLevel); lv != nil {
		add("level = ANY($%d)", lv)
	}
	if f.Q != "" {
		add(`message ILIKE '%%' || $%d || '%%' ESCAPE '\'`, escapeLike(f.Q))
	}
	if f.RequestID != "" {
		add("request_id = $%d", f.RequestID)
	}
	if f.UserID != "" {
		add("user_id = $%d", f.UserID)
	}
	if f.Since != nil {
		add("created_at >= $%d", *f.Since)
	}
	if f.Until != nil {
		add("created_at <= $%d", *f.Until)
	}
	if f.BeforeID > 0 {
		add("id < $%d", f.BeforeID)
	}
	q := `SELECT id, created_at, level, message, request_id, user_id, route, job, attrs FROM app_logs`
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	q += fmt.Sprintf(" ORDER BY id DESC LIMIT %d", AppLogClampLimit(f.Limit))
	rows, err := pool.Query(logging.NoTrace(ctx), q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AppLog{}
	for rows.Next() {
		var l AppLog
		var raw []byte
		if err := rows.Scan(&l.ID, &l.CreatedAt, &l.Level, &l.Message, &l.RequestID, &l.UserID, &l.Route, &l.Job, &raw); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(raw, &l.Attrs)
		out = append(out, l)
	}
	return out, rows.Err()
}
