package database

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Lookups and list-to-list moves for the Day Track MCP tools. A move is one transaction, so a
// failure halfway can't leave an item in both Today's Log and Planned & Carry Over: the page
// does the same moves as separate API calls, and "never both at once" is its rule.

const dayTrackEntryCols = `id, user_id, entry_date::text, name, category, COALESCE(start_time,''), COALESCE(end_time,''),
	duration_mins, COALESCE(notes,''), status, parent_entry_id,
	COALESCE(entry_source,'manual'), COALESCE(external_ref,''), youtrack_issue_id,
	created_at, updated_at`

const dayTrackPlannedCols = `id, user_id, entry_date::text, name, category, COALESCE(scheduled_time,''),
	COALESCE(start_time,''), COALESCE(end_time,''), when_type, COALESCE(notes,''), status,
	COALESCE(entry_source,'manual'), COALESCE(external_ref,''), youtrack_issue_id, created_at, updated_at`

func scanDayTrackEntry(row pgx.Row) (*DayTrackEntry, error) {
	var e DayTrackEntry
	err := row.Scan(&e.ID, &e.UserID, &e.EntryDate, &e.Name, &e.Category,
		&e.StartTime, &e.EndTime, &e.DurationMins, &e.Notes, &e.Status, &e.ParentEntryID,
		&e.EntrySource, &e.ExternalRef, &e.YoutrackIssueID,
		&e.CreatedAt, &e.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &e, nil
}

func scanDayTrackPlanned(row pgx.Row) (*DayTrackPlanned, error) {
	var p DayTrackPlanned
	err := row.Scan(&p.ID, &p.UserID, &p.EntryDate, &p.Name, &p.Category,
		&p.ScheduledTime, &p.StartTime, &p.EndTime, &p.WhenType, &p.Notes, &p.Status,
		&p.EntrySource, &p.ExternalRef, &p.YoutrackIssueID, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// FindEntry returns the user's entry, or nil when there is none. Unlike GetEntryByID it tells
// "not there" apart from a failed query, and it includes youtrack_issue_id.
func (r *DayTrackRepository) FindEntry(ctx context.Context, id, userID string) (*DayTrackEntry, error) {
	e, err := scanDayTrackEntry(GetPool().QueryRow(ctx,
		`SELECT `+dayTrackEntryCols+` FROM daytrack_entries WHERE id=$1 AND user_id=$2`, id, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return e, err
}

// FindPlanned returns the user's Planned & Carry Over item, or nil when there is none.
func (r *DayTrackRepository) FindPlanned(ctx context.Context, id, userID string) (*DayTrackPlanned, error) {
	p, err := scanDayTrackPlanned(GetPool().QueryRow(ctx,
		`SELECT `+dayTrackPlannedCols+` FROM daytrack_planned WHERE id=$1 AND user_id=$2`, id, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return p, err
}

// GetSubtasks returns an entry's subtasks, oldest first.
func (r *DayTrackRepository) GetSubtasks(ctx context.Context, parentID, userID string) ([]DayTrackEntry, error) {
	rows, err := GetPool().Query(ctx,
		`SELECT `+dayTrackEntryCols+` FROM daytrack_entries WHERE parent_entry_id=$1 AND user_id=$2 ORDER BY created_at ASC`,
		parentID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DayTrackEntry{}
	for rows.Next() {
		e, err := scanDayTrackEntry(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

// freeExternalRef returns ref, or "" when table already holds it for this user. A ticket can
// reach the same list twice over its life (finished, reopened, finished again), and the unique
// index on (user_id, external_ref) would otherwise fail the whole move.
func freeExternalRef(ctx context.Context, tx pgx.Tx, table, userID, ref string) (string, error) {
	if ref == "" {
		return "", nil
	}
	var taken bool
	err := tx.QueryRow(ctx,
		fmt.Sprintf(`SELECT EXISTS(SELECT 1 FROM %s WHERE user_id=$1 AND external_ref=$2)`, table),
		userID, ref).Scan(&taken)
	if err != nil {
		return "", err
	}
	if taken {
		return "", nil
	}
	return ref, nil
}

// CompletePlanned moves a Planned & Carry Over item into Today's Log as done. done carries the
// values for the new entry; the item's source and ticket links come across with it.
func (r *DayTrackRepository) CompletePlanned(ctx context.Context, item *DayTrackPlanned, done DayTrackEntry) (*DayTrackEntry, error) {
	tx, err := GetPool().Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	ref, err := freeExternalRef(ctx, tx, "daytrack_entries", item.UserID, item.ExternalRef)
	if err != nil {
		return nil, err
	}
	created, err := scanDayTrackEntry(tx.QueryRow(ctx,
		`INSERT INTO daytrack_entries (user_id, entry_date, name, category, start_time, end_time, duration_mins, notes, status, entry_source, external_ref, youtrack_issue_id)
		 VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, 'done', $9, $10, $11)
		 RETURNING `+dayTrackEntryCols,
		item.UserID, done.EntryDate, done.Name, done.Category, nullStr(done.StartTime), nullStr(done.EndTime),
		done.DurationMins, done.Notes, item.EntrySource, nullStr(ref), item.YoutrackIssueID))
	if err != nil {
		return nil, err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM daytrack_planned WHERE id=$1 AND user_id=$2`, item.ID, item.UserID)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, errors.New("that planned item no longer exists")
	}
	return created, tx.Commit(ctx)
}

func insertCarried(ctx context.Context, tx pgx.Tx, p DayTrackPlanned) (*DayTrackPlanned, error) {
	ref, err := freeExternalRef(ctx, tx, "daytrack_planned", p.UserID, p.ExternalRef)
	if err != nil {
		return nil, err
	}
	return scanDayTrackPlanned(tx.QueryRow(ctx,
		`INSERT INTO daytrack_planned (user_id, entry_date, name, category, scheduled_time, start_time, end_time, when_type, notes, status, entry_source, external_ref, youtrack_issue_id)
		 VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		 RETURNING `+dayTrackPlannedCols,
		p.UserID, p.EntryDate, p.Name, p.Category, nullStr(p.ScheduledTime), nullStr(p.StartTime), nullStr(p.EndTime),
		p.WhenType, p.Notes, p.Status, p.EntrySource, nullStr(ref), p.YoutrackIssueID))
}

// CarryEntry moves an entry out of Today's Log into Planned & Carry Over. carried carries the
// values for the new item. Subtasks go with it as their own items, marked with the parent's
// name the way the page's carry action does, because Planned has no parent link.
func (r *DayTrackRepository) CarryEntry(ctx context.Context, e *DayTrackEntry, subs []DayTrackEntry, carried DayTrackPlanned) (*DayTrackPlanned, error) {
	tx, err := GetPool().Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	for _, s := range subs {
		note := strings.TrimSpace("[subtask of " + e.Name + "] " + s.Notes)
		if _, err := insertCarried(ctx, tx, DayTrackPlanned{
			UserID: e.UserID, EntryDate: carried.EntryDate, Name: s.Name, Category: s.Category,
			ScheduledTime: s.StartTime, StartTime: s.StartTime, EndTime: s.EndTime,
			WhenType: carried.WhenType, Notes: note, Status: carried.Status, EntrySource: "manual",
		}); err != nil {
			return nil, err
		}
	}
	carried.UserID = e.UserID
	carried.EntrySource = e.EntrySource
	carried.ExternalRef = e.ExternalRef
	carried.YoutrackIssueID = e.YoutrackIssueID
	created, err := insertCarried(ctx, tx, carried)
	if err != nil {
		return nil, err
	}
	// Subtasks go through the parent's ON DELETE CASCADE.
	tag, err := tx.Exec(ctx, `DELETE FROM daytrack_entries WHERE id=$1 AND user_id=$2`, e.ID, e.UserID)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, errors.New("that entry no longer exists")
	}
	return created, tx.Commit(ctx)
}
