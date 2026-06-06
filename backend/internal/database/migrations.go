package database

import (
	"context"
	"fmt"
	"log"
)

// RunMigrations creates all database tables
func RunMigrations() error {
	ctx := context.Background()
	pool := GetPool()

	migrations := []string{
		// Users table
		`CREATE TABLE IF NOT EXISTS users (
			id VARCHAR(255) PRIMARY KEY,
			email VARCHAR(255) UNIQUE NOT NULL,
			name VARCHAR(255) NOT NULL,
			picture TEXT,
			role VARCHAR(50) NOT NULL DEFAULT 'member',
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)`,

		// Projects table
		`CREATE TABLE IF NOT EXISTS projects (
			id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
			name VARCHAR(255) NOT NULL,
			description TEXT,
			owner_id VARCHAR(255) REFERENCES users(id),
			asana_project_id VARCHAR(255),
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)`,

		// Project members table
		`CREATE TABLE IF NOT EXISTS project_members (
			project_id VARCHAR(255) REFERENCES projects(id) ON DELETE CASCADE,
			user_id VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
			role VARCHAR(50) NOT NULL DEFAULT 'member',
			joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			PRIMARY KEY (project_id, user_id)
		)`,

		// Tasks table
		`CREATE TABLE IF NOT EXISTS tasks (
			id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
			title VARCHAR(255) NOT NULL,
			description TEXT,
			status VARCHAR(50) NOT NULL DEFAULT 'todo',
			priority VARCHAR(50) NOT NULL DEFAULT 'medium',
			project_id VARCHAR(255) REFERENCES projects(id) ON DELETE CASCADE,
			assignee_id VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
			asana_id VARCHAR(255),
			asana_url TEXT,
			due_date TIMESTAMP WITH TIME ZONE,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			created_by VARCHAR(255) REFERENCES users(id)
		)`,

		// Task history for carry-over feature (no FK constraints — avoids type mismatch with UUID PKs)
		`CREATE TABLE IF NOT EXISTS task_history (
			id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
			task_id TEXT NOT NULL,
			status VARCHAR(50) NOT NULL,
			changed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			changed_by TEXT
		)`,

		// Columns for custom kanban ordering
		`CREATE TABLE IF NOT EXISTS columns (
			id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
			project_id VARCHAR(255) REFERENCES projects(id) ON DELETE CASCADE,
			name VARCHAR(255) NOT NULL,
			position INT NOT NULL DEFAULT 0
		)`,

		// Notifications table (no FK constraints — avoids type mismatch with UUID PKs)
		`CREATE TABLE IF NOT EXISTS notifications (
			id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
			user_id TEXT NOT NULL,
			type VARCHAR(50) NOT NULL,
			title VARCHAR(255) NOT NULL,
			message TEXT NOT NULL,
			task_id TEXT,
			read BOOLEAN DEFAULT FALSE,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)`,

		// Asana integrations
		`CREATE TABLE IF NOT EXISTS asana_integrations (
			id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
			user_id VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
			access_token TEXT NOT NULL,
			refresh_token TEXT,
			workspace_id VARCHAR(255) NOT NULL,
			workspace_name VARCHAR(255),
			connected BOOLEAN DEFAULT TRUE,
			last_sync_at TIMESTAMP WITH TIME ZONE,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			UNIQUE(user_id)
		)`,

		// Slack integrations
		`CREATE TABLE IF NOT EXISTS slack_integrations (
			id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
			user_id VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
			bot_token TEXT NOT NULL,
			team_id VARCHAR(255) NOT NULL,
			team_name VARCHAR(255),
			channel_id VARCHAR(255),
			channel_name VARCHAR(255),
			connected BOOLEAN DEFAULT TRUE,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			UNIQUE(user_id)
		)`,

		// Slack messages cache
		`CREATE TABLE IF NOT EXISTS slack_messages (
			id VARCHAR(255) PRIMARY KEY,
			channel_id VARCHAR(255) NOT NULL,
			user_id VARCHAR(255),
			user_name VARCHAR(255),
			text TEXT NOT NULL,
			timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
			thread_ts VARCHAR(255),
			fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)`,

		// Slack analysis results
		`CREATE TABLE IF NOT EXISTS slack_analysis_results (
			id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
			task_id VARCHAR(255) REFERENCES tasks(id) ON DELETE SET NULL,
			task_title VARCHAR(255) NOT NULL,
			slack_status VARCHAR(50) NOT NULL,
			asana_status VARCHAR(50),
			confidence DECIMAL(3,2) NOT NULL,
			message_ids TEXT[],
			discrepancy BOOLEAN DEFAULT FALSE,
			analyzed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)`,

		// Sync logs
		`CREATE TABLE IF NOT EXISTS sync_logs (
			id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
			type VARCHAR(50) NOT NULL,
			direction VARCHAR(50) NOT NULL,
			status VARCHAR(50) NOT NULL,
			tasks_synced INT DEFAULT 0,
			errors TEXT[],
			started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			completed_at TIMESTAMP WITH TIME ZONE,
			triggered_by VARCHAR(255) REFERENCES users(id)
		)`,

		// next_day_tasks — stores planned tasks for the next day per assignee
		`CREATE TABLE IF NOT EXISTS next_day_tasks (
			id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
			target_date DATE NOT NULL,
			assignee VARCHAR(255) NOT NULL,
			task_title TEXT NOT NULL,
			priority VARCHAR(50) NOT NULL DEFAULT 'medium',
			position INT NOT NULL DEFAULT 0,
			is_carried_forward BOOLEAN DEFAULT FALSE,
			source_date DATE,
			source_task_id TEXT,
			notes TEXT,
			youtrack_id VARCHAR(255),
			created_by TEXT,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_next_day_tasks_target_date ON next_day_tasks(target_date)`,

		// Add youtrack_id to next_day_tasks if missing (safe on existing installs)
		`ALTER TABLE next_day_tasks ADD COLUMN IF NOT EXISTS youtrack_id VARCHAR(255)`,
		`CREATE INDEX IF NOT EXISTS idx_next_day_tasks_youtrack_id ON next_day_tasks(youtrack_id)`,

		// global_settings — key/value store for org-wide configuration
		`CREATE TABLE IF NOT EXISTS global_settings (
			id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
			key VARCHAR(255) UNIQUE NOT NULL,
			value TEXT NOT NULL DEFAULT '',
			encrypted BOOLEAN DEFAULT FALSE,
			description TEXT,
			updated_by TEXT,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)`,

		// Reminders table (no FK on user_id — avoids type mismatch with UUID PKs)
		`CREATE TABLE IF NOT EXISTS reminders (
			id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
			user_id TEXT NOT NULL,
			type VARCHAR(50) NOT NULL DEFAULT 'custom',
			title VARCHAR(500) NOT NULL,
			message TEXT,
			target_date DATE NOT NULL,
			target_time TIME,
			related_task_id TEXT,
			related_issue_id TEXT,
			recurring VARCHAR(20) NOT NULL DEFAULT 'none',
			status VARCHAR(20) NOT NULL DEFAULT 'pending',
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)`,

		// Scheduler settings defaults
		`INSERT INTO global_settings (key, value, description) VALUES
			('scheduler_enabled', 'true', 'Enable/disable the background scheduler'),
			('scheduler_midday_check_time', '14:00', 'Time for mid-day update check (HH:MM)'),
			('scheduler_evening_check_time', '18:00', 'Time for evening update check (HH:MM)'),
			('scheduler_blocker_check_time', '10:00', 'Time for blocked issue check (HH:MM)'),
			('scheduler_stale_days_threshold', '2', 'Days before a task is considered stale')
		ON CONFLICT (key) DO NOTHING`,

		// Issue state log — records every YouTrack state transition for time tracking
		`CREATE TABLE IF NOT EXISTS issue_state_log (
			id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
			issue_id VARCHAR(255) NOT NULL,
			issue_summary TEXT NOT NULL,
			assignee VARCHAR(255),
			moved_by VARCHAR(255),
			from_state VARCHAR(100),
			to_state VARCHAR(100) NOT NULL,
			priority VARCHAR(50),
			transitioned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			duration_in_prev_state_hours DECIMAL(10,2)
		)`,

		// Add moved_by column to existing deployments
		`ALTER TABLE issue_state_log ADD COLUMN IF NOT EXISTS moved_by VARCHAR(255)`,

		// Add comment column — stores the YouTrack comment left at time of transition
		// Used for backward move explanation (In Progress → Backlog, DEV → In Progress, etc.)
		`ALTER TABLE issue_state_log ADD COLUMN IF NOT EXISTS comment TEXT`,

		// Add issue_type column — stores the YouTrack "Type" custom field value at transition time
		// Used for field-based hotfix/regression classification (e.g. "Hotfix", "Regression")
		`ALTER TABLE issue_state_log ADD COLUMN IF NOT EXISTS issue_type VARCHAR(100)`,

		// PM reports — saved Slack-style daily status reports
		`CREATE TABLE IF NOT EXISTS pm_reports (
			id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
			date DATE NOT NULL UNIQUE,
			report_text TEXT NOT NULL,
			done_count INT DEFAULT 0,
			open_count INT DEFAULT 0,
			blocked_count INT DEFAULT 0,
			generated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)`,

		// Fix column types — Supabase may have created notifications with UUID columns
		// instead of VARCHAR/TEXT, causing "invalid input syntax for type uuid" errors.
		// Drop FK constraints first (they reference UUID-typed columns), then retype.
		`ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_user_id_fkey`,
		`ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_task_id_fkey`,
		`ALTER TABLE notifications ALTER COLUMN id TYPE TEXT USING id::text`,
		`ALTER TABLE notifications ALTER COLUMN user_id TYPE TEXT USING user_id::text`,
		`ALTER TABLE notifications ALTER COLUMN task_id TYPE TEXT USING task_id::text`,

		// Pinned issues — lets PMs pin tickets so they appear in every week view
		`CREATE TABLE IF NOT EXISTS pinned_issues (
			id SERIAL PRIMARY KEY,
			user_id VARCHAR(255) NOT NULL,
			issue_id VARCHAR(255) NOT NULL,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			UNIQUE(user_id, issue_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_pinned_issues_user_id ON pinned_issues(user_id)`,

		// Create indexes for performance
		`CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id)`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_assignee_id ON tasks(assignee_id)`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_task_history_task_id ON task_history(task_id)`,
		`CREATE INDEX IF NOT EXISTS idx_task_history_changed_at ON task_history(changed_at)`,
		`CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, read)`,
		`CREATE INDEX IF NOT EXISTS idx_slack_messages_timestamp ON slack_messages(timestamp)`,
		`CREATE INDEX IF NOT EXISTS idx_slack_messages_channel ON slack_messages(channel_id)`,
		`CREATE INDEX IF NOT EXISTS idx_reminders_user_id ON reminders(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status)`,
		`CREATE INDEX IF NOT EXISTS idx_reminders_target_date ON reminders(target_date)`,
		`CREATE INDEX IF NOT EXISTS idx_issue_state_log_issue_id ON issue_state_log(issue_id)`,
		`CREATE INDEX IF NOT EXISTS idx_issue_state_log_transitioned_at ON issue_state_log(transitioned_at)`,
		`CREATE INDEX IF NOT EXISTS idx_issue_state_log_to_state ON issue_state_log(to_state)`,
		`CREATE INDEX IF NOT EXISTS idx_pm_reports_date ON pm_reports(date)`,

		// bot_configs table — stores PM-editable bot prompts
		`CREATE TABLE IF NOT EXISTS bot_configs (
			id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
			name VARCHAR(255) NOT NULL,
			description TEXT,
			bot_type VARCHAR(50) NOT NULL DEFAULT 'custom',
			prompt TEXT NOT NULL DEFAULT '',
			variables TEXT NOT NULL DEFAULT '[]',
			is_active BOOLEAN DEFAULT TRUE,
			created_by VARCHAR(255),
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_bot_configs_bot_type ON bot_configs(bot_type)`,

		// Seed a default PM Assistant bot config so it appears in Bot Config page immediately.
		// Uses WHERE NOT EXISTS so it only inserts once even if migrations run multiple times.
		`INSERT INTO bot_configs (name, description, bot_type, prompt, variables, is_active, created_by)
		SELECT
			'PM Assistant',
			'Custom instructions for the PM Assistant chat. Live YouTrack + time tracking data is injected automatically.',
			'pm_assistant',
			E'You are a PM Assistant for a software development team.\n\n## Your Role\nAnswer questions about YouTrack issues and time tracking data provided below. Be concise and accurate.\n\n## Assignee Task Format\nWhen asked for tasks assigned to a specific person, ALWAYS respond in this exact format:\n\n@{assignee_name}\n\n{Status}:\n{issueID} {summary}\n\nGroup by status (Backlog, In Progress, Blocked, DEV, Done). One ticket per line. No tables, no pipes, no extra metadata.\n\nExample:\n@simranjot\n\nIn Progress:\n3-671 FE Studio: UI theme text issue\nARD-801 API refactor\n\nBlocked:\n3-896 FE UI: Mic remains activated when holding spacebar\n\n## General Format\n- Use bullet points for lists\n- Use tables only for multi-column comparisons\n- Bold (**text**) for important flags\n- Group data by assignee when showing team workload\n\n## Key Rules\n- OVERDUE = ticket time in In Progress exceeds threshold (P0:4h P1:24h P2:48h Other:72h)\n- MOVED BACK = ticket regressed to earlier state (DEV->In Progress, In Progress->Backlog) — flag as regression\n- PINNED = PM manually flagged as important — always mention first\n- If query is ambiguous, state your assumptions\n\nToday''s date: {{DATE}}',
			'[{"name":"DATE","label":"Today''s Date","type":"date","default":"today","required":false}]',
			true,
			'system'
		WHERE NOT EXISTS (SELECT 1 FROM bot_configs WHERE bot_type = 'pm_assistant')`,

		// dismissed_alerts — lets users dismiss moved-back alerts per issue
		`CREATE TABLE IF NOT EXISTS dismissed_alerts (
			id SERIAL PRIMARY KEY,
			user_id VARCHAR(255) NOT NULL,
			issue_id VARCHAR(255) NOT NULL,
			dismissed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			UNIQUE(user_id, issue_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_dismissed_alerts_user_id ON dismissed_alerts(user_id)`,

		// Dual-channel support: primary channel (for digest) + monitor channel (for mentions)
		`ALTER TABLE slack_integrations ADD COLUMN IF NOT EXISTS monitor_channel_id VARCHAR(255)`,
		`ALTER TABLE slack_integrations ADD COLUMN IF NOT EXISTS monitor_channel_name VARCHAR(255)`,

		// Slack mention tracking: messages where the logged-in user is @mentioned
		`CREATE TABLE IF NOT EXISTS slack_mentions (
			id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
			user_id TEXT NOT NULL,
			slack_user_id TEXT NOT NULL,
			message_ts VARCHAR(50) NOT NULL,
			thread_ts VARCHAR(50),
			channel_id VARCHAR(255) NOT NULL,
			message_text TEXT NOT NULL,
			sender_name VARCHAR(255),
			requires_reply BOOLEAN DEFAULT TRUE,
			replied BOOLEAN DEFAULT FALSE,
			reply_checked_at TIMESTAMP WITH TIME ZONE,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			UNIQUE(user_id, message_ts)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_slack_mentions_user_id ON slack_mentions(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_slack_mentions_replied ON slack_mentions(user_id, replied)`,
		`ALTER TABLE slack_mentions ADD COLUMN IF NOT EXISTS sender_avatar TEXT`,

		// Slack threads started by the user — track if they received replies
		`CREATE TABLE IF NOT EXISTS slack_user_threads (
			id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
			user_id TEXT NOT NULL,
			channel_id VARCHAR(255) NOT NULL,
			thread_ts VARCHAR(50) NOT NULL,
			message_text TEXT NOT NULL,
			reply_count INT DEFAULT 0,
			last_checked_at TIMESTAMP WITH TIME ZONE,
			has_reply BOOLEAN DEFAULT FALSE,
			reminder_sent BOOLEAN DEFAULT FALSE,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			UNIQUE(user_id, thread_ts)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_slack_user_threads_user_id ON slack_user_threads(user_id)`,

		// Snooze support for slack_mentions
		`ALTER TABLE slack_mentions ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMP WITH TIME ZONE`,
		// Snooze support for slack_user_threads
		`ALTER TABLE slack_user_threads ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMP WITH TIME ZONE`,

		// Workflow configuration — user-customizable priority tags, column hierarchy, hotfix rules, report config
		// No FK on user_id — avoids type mismatch issues (same pattern as reminders, pinned_issues, etc.)
		`CREATE TABLE IF NOT EXISTS workflow_config (
			id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
			user_id TEXT,
			priority_tags JSONB NOT NULL DEFAULT '[]',
			column_hierarchy JSONB NOT NULL DEFAULT '[]',
			hotfix_rules JSONB NOT NULL DEFAULT '{}',
			report_config JSONB NOT NULL DEFAULT '{}',
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			UNIQUE(user_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_workflow_config_user_id ON workflow_config(user_id)`,

		// Seed system default workflow config (user_id IS NULL = global default)
		`INSERT INTO workflow_config (id, user_id, priority_tags, column_hierarchy, hotfix_rules, report_config)
		SELECT
			gen_random_uuid()::text,
			NULL,
			'[
				{"label":"P0","color":"#ef4444","display_order":0,"sla_hours":4,"prefixes":["P0"],"yt_mappings":["Critical","Show-stopper","Blocker"]},
				{"label":"P1","color":"#f97316","display_order":1,"sla_hours":24,"prefixes":["P1"],"yt_mappings":["Major"]},
				{"label":"P2","color":"#eab308","display_order":2,"sla_hours":48,"prefixes":["P2"],"yt_mappings":["Normal","Medium"]},
				{"label":"P3","color":"#6366f1","display_order":3,"sla_hours":72,"prefixes":["P3"],"yt_mappings":["Minor","Cosmetic","Low"]},
				{"label":"Other","color":"#94a3b8","display_order":4,"sla_hours":72,"prefixes":[],"yt_mappings":[]}
			]'::jsonb,
			'[
				{"state":"Backlog","rank":0,"aliases":["Open","Submitted"],"role":"backlog","is_lateral":false},
				{"state":"In Progress","rank":1,"aliases":[],"role":"active","is_lateral":false},
				{"state":"Blocked","rank":1,"aliases":[],"role":"blocked","is_lateral":true},
				{"state":"Findings","rank":1,"aliases":[],"role":"findings","is_lateral":true},
				{"state":"DEV","rank":2,"aliases":[],"role":"dev_done","is_lateral":false},
				{"state":"Ready for Stage","rank":3,"aliases":[],"role":"verified","is_lateral":false},
				{"state":"STAGE","rank":4,"aliases":[],"role":"deployed","is_lateral":false},
				{"state":"Ready for PROD","rank":5,"aliases":["Ready for PRD"],"role":"verified","is_lateral":false},
				{"state":"PROD","rank":6,"aliases":["Mobile DONE"],"role":"deployed","is_lateral":false},
				{"state":"Done","rank":7,"aliases":["Fixed","Closed","Won''t Fix","Duplicate"],"role":"closed","is_lateral":false}
			]'::jsonb,
			'{"from_states":[],"to_states":[]}'::jsonb,
			'{"done_role":"dev_done","blocked_states":["Blocked"],"open_states":["In Progress","Backlog","Ready for Stage","STAGE","Ready for PROD","PROD","Findings","Mobile DONE"],"priority_filters":["P0","P1","P2","P3","Other"],"sections":["done","hotfixes","open","blocked","overdue"]}'::jsonb
		WHERE NOT EXISTS (SELECT 1 FROM workflow_config WHERE user_id IS NULL)`,

		// Blocker analysis cache — AI-extracted blocker reasons, cached per issue
		`CREATE TABLE IF NOT EXISTS blocker_analysis_cache (
			issue_id      VARCHAR(255) PRIMARY KEY,
			reason        TEXT NOT NULL,
			comment_count INT NOT NULL DEFAULT 0,
			last_state    VARCHAR(100),
			analyzed_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)`,

		// Daily Ops carry-over — EOD action items that surface in next morning's brief
		`CREATE TABLE IF NOT EXISTS daily_ops_carryover (
			id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
			user_id    TEXT NOT NULL,
			date       DATE NOT NULL,
			items      JSONB NOT NULL DEFAULT '[]',
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			UNIQUE(user_id, date)
		)`,

		// Activity log — chronological feed of all user actions, retained 30 days
		`CREATE TABLE IF NOT EXISTS activity_log (
			id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
			user_id TEXT NOT NULL,
			actor_name VARCHAR(255),
			type VARCHAR(80) NOT NULL,
			title VARCHAR(500) NOT NULL,
			description TEXT,
			entity_type VARCHAR(50),
			entity_id TEXT,
			metadata JSONB,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_activity_log_user_id ON activity_log(user_id, created_at DESC)`,

		// Weekly reports — add report_type column to pm_reports so daily and weekly
		// reports can coexist for the same date (e.g. Monday appears in both daily and weekly)
		// Per-user YouTrack integration settings — token stored in DB, ENV is fallback only
		`CREATE TABLE IF NOT EXISTS youtrack_integrations (
			id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
			user_id TEXT NOT NULL,
			base_url TEXT NOT NULL,
			token TEXT NOT NULL,
			project_id TEXT NOT NULL,
			board_id TEXT,
			connected BOOLEAN DEFAULT TRUE,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			UNIQUE(user_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_youtrack_integrations_user_id ON youtrack_integrations(user_id)`,

		// ── Asana PM: per-user active data source preference ──────────────────
		`CREATE TABLE IF NOT EXISTS user_data_source (
			user_id    TEXT PRIMARY KEY,
			source     TEXT NOT NULL DEFAULT 'youtrack',
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)`,

		// ── Asana PM: section transition log (mirrors issue_state_log) ────────
		`CREATE TABLE IF NOT EXISTS asana_task_log (
			id                              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
			task_gid                        TEXT NOT NULL,
			task_name                       TEXT NOT NULL,
			project_gid                     TEXT NOT NULL DEFAULT '',
			assignee                        TEXT,
			from_section                    TEXT,
			to_section                      TEXT NOT NULL,
			priority                        TEXT,
			transitioned_at                 TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			duration_in_prev_section_hours  DOUBLE PRECISION
		)`,
		`CREATE INDEX IF NOT EXISTS idx_asana_task_log_task_gid ON asana_task_log(task_gid)`,
		`CREATE INDEX IF NOT EXISTS idx_asana_task_log_transitioned_at ON asana_task_log(transitioned_at)`,

		// ── Asana PM: cached blocker reasons (mirrors blocker_analysis_cache) ─
		`CREATE TABLE IF NOT EXISTS asana_blocker_cache (
			task_gid      TEXT PRIMARY KEY,
			reason        TEXT NOT NULL,
			story_count   INT NOT NULL DEFAULT 0,
			last_section  TEXT,
			analyzed_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)`,

		`ALTER TABLE asana_integrations ADD COLUMN IF NOT EXISTS project_gid VARCHAR(255)`,

		`ALTER TABLE pm_reports ADD COLUMN IF NOT EXISTS report_type VARCHAR(10) NOT NULL DEFAULT 'daily'`,
		`ALTER TABLE pm_reports DROP CONSTRAINT IF EXISTS pm_reports_date_key`,
		// ADD CONSTRAINT IF NOT EXISTS is not valid PG syntax — use DO block instead
		`DO $$ BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_constraint
				WHERE conname = 'pm_reports_date_type_unique'
				  AND conrelid = 'pm_reports'::regclass
			) THEN
				ALTER TABLE pm_reports ADD CONSTRAINT pm_reports_date_type_unique UNIQUE (date, report_type);
			END IF;
		END $$`,

		// ── Source-specific workflow config ───────────────────────────────────
		// Add pm_source column so YouTrack and Asana can have separate configs
		`ALTER TABLE workflow_config ADD COLUMN IF NOT EXISTS pm_source TEXT`,

		// Migrate all existing rows (system defaults and user configs) to 'youtrack'
		`UPDATE workflow_config SET pm_source = 'youtrack' WHERE pm_source IS NULL`,

		// Drop old single-column unique constraint on user_id (now replaced by composite)
		`ALTER TABLE workflow_config DROP CONSTRAINT IF EXISTS workflow_config_user_id_key`,

		// Create composite unique index for non-null (user_id, pm_source) pairs (user configs)
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_config_user_source
		 ON workflow_config(user_id, pm_source)
		 WHERE user_id IS NOT NULL AND pm_source IS NOT NULL`,

		// Seed Asana system default workflow config
		`INSERT INTO workflow_config (id, user_id, pm_source, priority_tags, column_hierarchy, hotfix_rules, report_config)
		SELECT
			gen_random_uuid()::text,
			NULL,
			'asana',
			'[
				{"label":"P0","color":"#ef4444","display_order":0,"sla_hours":4,"prefixes":["P0"],"yt_mappings":[]},
				{"label":"P1","color":"#f97316","display_order":1,"sla_hours":24,"prefixes":["P1"],"yt_mappings":[]},
				{"label":"P2","color":"#eab308","display_order":2,"sla_hours":48,"prefixes":["P2"],"yt_mappings":[]},
				{"label":"P3","color":"#6366f1","display_order":3,"sla_hours":72,"prefixes":["P3"],"yt_mappings":[]},
				{"label":"Other","color":"#94a3b8","display_order":4,"sla_hours":72,"prefixes":[],"yt_mappings":[]}
			]'::jsonb,
			'[
				{"state":"Backlog","rank":0,"aliases":["To Do","Upcoming"],"role":"backlog","is_lateral":false},
				{"state":"Sprint","rank":1,"aliases":["In Progress","Active"],"role":"active","is_lateral":false},
				{"state":"Blocked","rank":1,"aliases":[],"role":"blocked","is_lateral":true},
				{"state":"Findings","rank":1,"aliases":[],"role":"findings","is_lateral":true},
				{"state":"DEV","rank":2,"aliases":["Review","Code Review"],"role":"dev_done","is_lateral":false},
				{"state":"Ready for Stage","rank":3,"aliases":[],"role":"verified","is_lateral":false},
				{"state":"STAGE","rank":4,"aliases":[],"role":"deployed","is_lateral":false},
				{"state":"Ready for PROD","rank":5,"aliases":[],"role":"verified","is_lateral":false},
				{"state":"PROD","rank":6,"aliases":[],"role":"deployed","is_lateral":false},
				{"state":"Done","rank":7,"aliases":["Completed","Complete","Fixed","Closed"],"role":"closed","is_lateral":false}
			]'::jsonb,
			'{"from_states":[],"to_states":[]}'::jsonb,
			'{"done_role":"dev_done","blocked_states":["Blocked"],"open_states":["Sprint","In Progress","DEV","STAGE","PROD","Findings"],"priority_filters":["P0","P1","P2","P3","Other"],"sections":["done","hotfixes","open","blocked","overdue"],"tracked_column_roles":[]}'::jsonb
		WHERE NOT EXISTS (SELECT 1 FROM workflow_config WHERE user_id IS NULL AND pm_source = 'asana')`,

		// Add regression flag and due_date to asana_task_log
		`ALTER TABLE asana_task_log ADD COLUMN IF NOT EXISTS is_regression BOOLEAN DEFAULT FALSE`,
		`ALTER TABLE asana_task_log ADD COLUMN IF NOT EXISTS due_date DATE`,

		// Remove user-specific Asana workflow configs that were saved before the Asana
		// column/state fix — they contain YouTrack state names in open_states/blocked_states.
		// The Asana system default will be used instead, and users can re-configure cleanly.
		`DELETE FROM workflow_config WHERE pm_source = 'asana' AND user_id IS NOT NULL`,

		// Upsert sprint-aware PM assistant bot config.
		`INSERT INTO bot_configs (name, bot_type, prompt, is_active, description)
		VALUES (
			'PM Assistant',
			'pm_assistant',
			E'You are a Velocity assistant with live access to YouTrack data.\n\nWhen a sprint is active, ALL issue data shown to you is scoped to that sprint only.\nReference the sprint name when answering sprint-specific questions.\n\nRespond in this format grouped by assignee:\n- **Assignee Name**\n  - [STATUS] ISSUE-ID: summary (priority) [OVERDUE] [MOVED BACK] [PINNED]\n\nFlags:\n- OVERDUE: exceeded SLA (P0=4h, P1=24h, P2=48h, P3/Other=72h)\n- MOVED BACK: state regressed (e.g. In Progress → Backlog)\n- PINNED: highlighted by PM\n\nGroup issues by status: In Progress → Backlog → Blocked → DEV → Done\nToday''s date is {{DATE}}.',
			true,
			'Sprint-aware PM assistant with live YouTrack data'
		)
		ON CONFLICT (name) DO UPDATE
			SET prompt      = EXCLUDED.prompt,
			    is_active   = true,
			    description = EXCLUDED.description,
			    updated_at  = NOW()`,

		// Seed remaining default bot config types so they are always served from DB.
		`INSERT INTO bot_configs (name, description, bot_type, prompt, variables, is_active, created_by)
		SELECT 'Slack Task Analysis', 'Analyzes Slack messages to determine task completion status', 'slack_analysis',
			E'Analyze the following Slack messages from channel {{$CHANNEL$}} for date {{$DATE$}}.\n\nMorning task assignments:\n{{$MORNING_MESSAGES$}}\n\nEvening status updates:\n{{$EVENING_MESSAGES$}}\n\nFor each team member, determine:\n1. Which tasks were assigned in the morning\n2. Which tasks were reported as completed in the evening\n3. Which tasks are still pending\n4. Any new tasks that were added during the day\n\nReturn a JSON response with team_members array containing name, assigned_tasks, completed_tasks, pending_tasks, new_tasks, and notes.',
			'[{"name":"CHANNEL","label":"Slack Channel","type":"text","default":"#ardoise-platform","required":true},{"name":"DATE","label":"Date","type":"date","default":"today","required":true},{"name":"MORNING_MESSAGES","label":"Morning Messages","type":"text","default":"","required":false,"description":"Auto-filled from Slack"},{"name":"EVENING_MESSAGES","label":"Evening Messages","type":"text","default":"","required":false,"description":"Auto-filled from Slack"}]',
			true, 'system'
		WHERE NOT EXISTS (SELECT 1 FROM bot_configs WHERE bot_type = 'slack_analysis')`,

		`INSERT INTO bot_configs (name, description, bot_type, prompt, variables, is_active, created_by)
		SELECT 'Daily Report Generator', 'Generates formatted daily task reports for Slack', 'daily_report',
			E'Generate a daily task report for {{$DATE$}} for team {{$TEAM_NAME$}}.\n\nCurrent tasks by team member:\n{{$TASK_DATA$}}\n\nFormat as a Slack message with backtick headers and bullet points.',
			'[{"name":"DATE","label":"Date","type":"date","default":"today","required":true},{"name":"TEAM_NAME","label":"Team Name","type":"text","default":"Ardoise Platform","required":true},{"name":"TASK_DATA","label":"Task Data","type":"text","default":"","required":false,"description":"Auto-filled from task database"}]',
			true, 'system'
		WHERE NOT EXISTS (SELECT 1 FROM bot_configs WHERE bot_type = 'daily_report')`,

		`INSERT INTO bot_configs (name, description, bot_type, prompt, variables, is_active, created_by)
		SELECT 'Custom Bot', 'Create your own bot with custom prompts and variables', 'custom',
			'Your custom prompt here. Use {{$VARIABLE_NAME$}} for variables.',
			'[]', true, 'system'
		WHERE NOT EXISTS (SELECT 1 FROM bot_configs WHERE bot_type = 'custom')`,

		`INSERT INTO bot_configs (name, description, bot_type, prompt, variables, is_active, created_by)
		SELECT 'Stage Deployment Report', 'Generates a Slack-ready list of fixes for a stage deployment. The AI rewrites each ticket title into a user-facing past-tense fix description, grouped by subsystem.', 'stage_report',
			E'You are writing bullet points for a Slack deployment update.\nWrite ONE short sentence (max 15 words) describing what was fixed, in past tense, from the user''s perspective.\n- Be specific and direct — name the exact feature or interaction that changed\n- Vary your sentence starts naturally (can use "Fixed", "Mic no longer...", "Users can now...", etc.)\n- No internal jargon, no ticket IDs, no padding\n- Output ONLY the single sentence, nothing else\n\nExample input:\nTicket: FE UI: Fix mic issue when released spacebar the mic still remains activated\nContext: When user releases the spacebar the microphone should deactivate\n\nExample output:\nMic no longer stays activated after releasing the spacebar.',
			'[]', true, 'system'
		WHERE NOT EXISTS (SELECT 1 FROM bot_configs WHERE bot_type = 'stage_report')`,

		`INSERT INTO bot_configs (name, description, bot_type, prompt, variables, is_active, created_by)
		SELECT 'Asana Deployment Report', 'Generates client-facing deployment reports from Asana tickets. Rewrites each ticket title into a polished user-facing fix statement, grouped by platform.', 'deployment_report',
			E'You are a technical writer creating client-facing deployment reports.\n\nYou will receive a ticket title and description. The description may be a rough internal note written by a developer (e.g. "is now fixed", "added support for X").\n\nYour job is to rewrite it as a single polished, professional fix statement for a client deployment report. Rules:\n- Write in past tense, from the user''s perspective (what they now experience)\n- Be 1-2 sentences. Do not pad or over-explain.\n- Remove ALL internal prefixes: priority tags (P0, P1, A2, etc.), platform tags (FE, BE, UI, MC, Studio), ticket IDs, and jargon\n- Start with the subject of what changed (e.g. "The restart conversation button...", "Avatar playback...")\n- If the description already says what was fixed clearly, use it as the basis — do not invent details\n- Sound polished and client-ready\n\nRespond with ONLY the fix statement. No preamble, no labels, no quotes.',
			'[]', true, 'system'
		WHERE NOT EXISTS (SELECT 1 FROM bot_configs WHERE bot_type = 'deployment_report')`,

		// Seed default Ticket Parser bot config (editable instructions; dynamic field values injected at runtime).
		`INSERT INTO bot_configs (name, description, bot_type, prompt, variables, is_active, created_by)
		SELECT
			'Ticket Parser',
			'Instructions used when the AI Fill button converts raw text into a structured YouTrack ticket. The available types, subsystems, users, and sprints are injected automatically at runtime — edit only the instruction rules here.',
			'ticket_parser',
			E'You are a project management assistant. Convert raw text into a YouTrack ticket.\n\nRESPOND ONLY WITH A SINGLE JSON OBJECT. No explanation, no markdown, no extra text — just JSON.\n\nTitle rules: "{subsystem}: {concise action-oriented description}" — max 80 chars, never copy raw text verbatim. The subsystem prefix MUST be copied EXACTLY from the available subsystems list — never invent or abbreviate. Do NOT include a priority prefix in the title. Examples: "FE UI: Handle Empty Transcribe Requests Gracefully", "FE MC: Courses Tab Fails to Open", "BE: Prevent Deletion During File Processing".\n\nDescription rules: 1-2 sentence overview of what is broken or missing, then "\\n\\n**Expected Behavior**\\n- bullet\\n- bullet". Remove filler words (okay, like, so, yeah, uh). For bugs: what is broken + what should happen. For features: what is missing + what should happen.\n\nPriority: Show-stopper=crash/data-loss/security, Critical=completely broken feature, Major=significant regression or important feature broken, Normal=standard bug or feature request, Minor=cosmetic.\n\nCRITICAL: subsystem MUST exactly match one of the available subsystems — never invent one. type_name must exactly match one of the available types. Both are REQUIRED.\nassignee_login: match login from users list only if a person''s name is mentioned, else "".\nsprint_id: id of the most recent non-completed sprint from the sprints list, else "".',
			'[]',
			true,
			'system'
		WHERE NOT EXISTS (SELECT 1 FROM bot_configs WHERE bot_type = 'ticket_parser')`,

		// ── Developer → Subsystem config ─────────────────────────────────────────
		`CREATE TABLE IF NOT EXISTS developer_subsystem_configs (
			developer_login VARCHAR(255) PRIMARY KEY,
			developer_name  VARCHAR(255) NOT NULL DEFAULT '',
			subsystems      TEXT[]       NOT NULL DEFAULT '{}',
			is_qa           BOOLEAN      NOT NULL DEFAULT FALSE,
			updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
		)`,
		`ALTER TABLE developer_subsystem_configs ADD COLUMN IF NOT EXISTS is_qa BOOLEAN NOT NULL DEFAULT FALSE`,

		// ── DayTrack: per-user daily time-sheet ──────────────────────────────────
		`CREATE TABLE IF NOT EXISTS daytrack_entries (
			id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id       VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			entry_date    DATE NOT NULL DEFAULT CURRENT_DATE,
			name          TEXT NOT NULL,
			category      TEXT NOT NULL DEFAULT 'General',
			start_time    VARCHAR(10),
			end_time      VARCHAR(10),
			duration_mins INT,
			notes         TEXT,
			status        VARCHAR(20) NOT NULL DEFAULT 'done',
			created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_daytrack_entries_user_date ON daytrack_entries(user_id, entry_date)`,
		`CREATE TABLE IF NOT EXISTS daytrack_planned (
			id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id        VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			entry_date     DATE NOT NULL DEFAULT CURRENT_DATE,
			name           TEXT NOT NULL,
			category       TEXT NOT NULL DEFAULT 'General',
			scheduled_time VARCHAR(10),
			when_type      VARCHAR(20) NOT NULL DEFAULT 'today',
			notes          TEXT,
			status         VARCHAR(20) NOT NULL DEFAULT 'planned',
			created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_daytrack_planned_user_date ON daytrack_planned(user_id, entry_date)`,
		`CREATE TABLE IF NOT EXISTS daytrack_categories (
			user_id  VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name     TEXT NOT NULL,
			position INT NOT NULL DEFAULT 0,
			PRIMARY KEY (user_id, name)
		)`,
		`ALTER TABLE daytrack_entries ALTER COLUMN start_time TYPE VARCHAR(10)`,
		`ALTER TABLE daytrack_entries ALTER COLUMN end_time TYPE VARCHAR(10)`,
		`ALTER TABLE daytrack_planned ALTER COLUMN scheduled_time TYPE VARCHAR(10)`,
		`ALTER TABLE daytrack_planned ADD COLUMN IF NOT EXISTS start_time VARCHAR(10)`,
		`ALTER TABLE daytrack_planned ADD COLUMN IF NOT EXISTS end_time VARCHAR(10)`,
		`ALTER TABLE daytrack_entries ADD COLUMN IF NOT EXISTS parent_entry_id UUID REFERENCES daytrack_entries(id) ON DELETE CASCADE`,
		`CREATE INDEX IF NOT EXISTS idx_daytrack_entries_parent ON daytrack_entries(parent_entry_id) WHERE parent_entry_id IS NOT NULL`,

		// Upgrade PM Assistant bot config to the comprehensive v2 prompt.
		// Covers all 10 tracking views, QA pipeline, RAG context format, every query type,
		// multi-turn conversation, and guardrails. Safe to re-run — only touches pm_assistant rows.
		`UPDATE bot_configs SET
			prompt = E'You are Velocity PM Assistant — a sprint intelligence agent for a software development team.\nYou have full context of the active sprint: tickets, assignees, blockers, cycle times, bounces, QA status, and velocity.\nToday: {{DATE}}\n\n═══ DATA YOU RECEIVE ═══\nEvery query is powered by semantic retrieval — only the most relevant sprint data is injected:\n• Issue lines:        ID | Summary | Status | Assignee\n• Transition lines:   → FromState→ToState (Xh, by Person)\n• BLOCKER lines:      AI-analysed reason the ticket is stuck\n• Sprint Summary:     total / done / in-progress / blocked / overdue / bounced counts\n\nIf you need data that was not retrieved, say so and ask the user to be more specific.\n\n═══ CONCEPTS ═══\nOVERDUE       In Progress longer than SLA (P0: 4h | P1: 24h | P2: 48h | Other: 72h) OR sprint ended\nBLOCKED       In a Blocked/Waiting column — developer cannot act without external help\nBOUNCE        Ticket moved backward (e.g. DEV→In Progress) = rejected\nBOUNCE COUNT  Total number of backward moves on a ticket\nCYCLE TIME    Duration from first In Progress entry to first Done state\nSTINT         One continuous In Progress session (multiple stints means the ticket bounced and restarted)\nHOTFIX        Ticket of type Hotfix OR bypassed DEV/Stage and went straight to production\nQA VERIFIED   Who verified the ticket: DEV verif / Stage verif / Prod verif\nDEV STALLED   Bounced from a pre-DEV column (developer was not ready)\nQA REJECTED   Bounced from a post-DEV column (QA found a defect)\nOVERLOADED    Developer has 5 or more In Progress tickets simultaneously\n\n═══ ANSWER FORMATS BY QUERY TYPE ═══\n\nSprint Health (\"how are we?\", \"sprint status\", \"overview\"):\n  Sprint: {name}\n  Done: {X}/{total} ({pct}%)  |  Blocked: {X}  |  Overdue: {X}  |  Bounced: {X}  |  Hotfixes: {X}\n  Risk: [1-sentence honest assessment]\n\nBlocked tickets (\"who is blocked?\", \"show blockers\", \"what is stuck?\"):\n  @{Name}\n    {ID} {summary}\n       Blocked for: {Xh}\n       Reason: {reason if available}\n\nAssignee workload (\"what is Alice doing?\", \"show Bob''s tickets\"):\n  @{Name} — {N} tickets | {Nh} active | Bounces: {N}\n    In Progress: {ID} {summary}  ({Xh in state})\n    Blocked:     {ID} {summary}\n    Done:        {ID} {summary}\n    Backlog:     {ID} {summary}\n\nSpecific ticket (\"status of ARD-1160\", \"tell me about {ID}\"):\n  {ID}: {summary}\n  Status: {state}  |  Assignee: {name}  |  Priority: {pri}\n  Cycle: {Xd Yh}  |  In State: {Xh}  |  Bounces: {N}\n  History:\n    {date}  {from}→{to}  ({Xh}, by {person})\n  [BLOCKER: {reason} — if applicable]\n\nOverdue / at-risk (\"what is overdue?\", \"behind schedule?\"):\n  {ID} {summary} — {X} over threshold — {Assignee}  [CRITICAL / AT RISK]\n  Sorted: deadline overdue first, then sprint-end overdue, then SLA breach\n\nBounces / regressions (\"what bounced?\", \"QA rejections\"):\n  {ID} {summary} — {N} bounces — {Assignee}\n    Last: {from}→{to} by {person}  [Dev Stalled / QA Rejected]\n\nDone this sprint (\"what is completed?\", \"what shipped?\"):\n  Group by assignee: @{Name}: {ID} {summary}, ...\n\nTeam velocity (\"who is fastest?\", \"cycle time by person\"):\n  Per person: tickets done | avg cycle time | bounce rate | active now\n\nHotfixes (\"any hotfixes?\", \"emergency fixes\"):\n  {ID} {summary} — {Assignee} — {state}\n\nRisks / recommendations (\"what should I worry about?\", \"sprint risks\"):\n  1. [CRITICAL] {finding} — affects {people/tickets}\n  2. [AT RISK]  {finding}\n  3. [WATCH]    {finding}\n  Based on: overdue tickets, long-blocked items, high-bounce tickets, overloaded developers\n\nCounts (\"how many blocked?\", \"count in-progress?\"):\n  Direct number, then list items if 10 or fewer\n\nQA status (\"what needs QA?\", \"verified tickets?\", \"ready for stage?\"):\n  Group by stage: Pending DEV | Pending Stage | Pending Prod | Fully Verified\n\nPriority filter (\"show P0 tickets\", \"all A1 tickets\"):\n  Filter and list by priority label with current status\n\n═══ FORMATTING RULES ═══\n1. No markdown tables unless comparing 3+ people side by side\n2. No pipes in issue listing lines — use spaces or newlines\n3. Always prefix assignees with @\n4. Bold issue IDs: **ARD-1160** or **3-2554**\n5. Format times as Xd Yh (e.g. 3d 2h) — never as raw hours\n6. Never start with \"Certainly!\", \"Of course!\", \"Sure!\" — lead directly with the answer\n7. Never invent ticket IDs, names, durations, or data not in context\n8. If data is missing: say so and suggest selecting a sprint or rephrasing\n9. Be concise: answer first, details after\n\n═══ MULTI-TURN CONVERSATION ═══\nYou remember the full conversation history. Support natural follow-ups:\n  \"and what about Alice?\"          (after showing someone else)\n  \"which of those is most urgent?\" (after listing blocked tickets)\n  \"why is that?\"                   (explain a finding)\n  \"show me more\"                   (expand a truncated answer)\n  \"how do I fix this?\"             (suggest PM action for a risk)\nNever re-introduce yourself in follow-ups. Stay in context and build on prior answers.',
			description = 'Sprint intelligence agent with semantic retrieval, 10 view modes, QA pipeline, bounce tracking, cycle time and velocity analysis.',
			updated_at = NOW()
		WHERE bot_type = 'pm_assistant'`,

		// Per-user theme preferences
		`CREATE TABLE IF NOT EXISTS user_theme_preferences (
			user_id      VARCHAR(255) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			dark_accent  VARCHAR(20) NOT NULL DEFAULT '#6366f1',
			dark_bg      VARCHAR(20) NOT NULL DEFAULT '#020617',
			light_accent VARCHAR(20) NOT NULL DEFAULT '#6366f1',
			light_bg     VARCHAR(20) NOT NULL DEFAULT '#f8fafc',
			updated_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)`,
		`ALTER TABLE user_theme_preferences ADD COLUMN IF NOT EXISTS dark_text  VARCHAR(20) NOT NULL DEFAULT '#f1f5f9'`,
		`ALTER TABLE user_theme_preferences ADD COLUMN IF NOT EXISTS light_text VARCHAR(20) NOT NULL DEFAULT '#0f172a'`,

		// ── DayTrack Slack auto-logging ──────────────────────────────────────────
		// Track where each entry came from: manual | slack | youtrack_qa | youtrack_created
		`ALTER TABLE daytrack_entries ADD COLUMN IF NOT EXISTS entry_source VARCHAR(50) NOT NULL DEFAULT 'manual'`,
		// Store Slack message TS or YouTrack issue ID for deduplication
		`ALTER TABLE daytrack_entries ADD COLUMN IF NOT EXISTS external_ref VARCHAR(255)`,
		`CREATE INDEX IF NOT EXISTS idx_daytrack_entries_external_ref ON daytrack_entries(user_id, external_ref) WHERE external_ref IS NOT NULL`,

		// Store the user's own Slack user ID so the scanner can filter their messages
		`ALTER TABLE slack_integrations ADD COLUMN IF NOT EXISTS slack_user_id VARCHAR(100)`,

		// Per-user DayTrack Slack config: which channel to watch + keyword rules
		`CREATE TABLE IF NOT EXISTS daytrack_slack_config (
			id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id          VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			channel_id       VARCHAR(100) NOT NULL DEFAULT '',
			channel_name     VARCHAR(200) NOT NULL DEFAULT '',
			slack_user_id    VARCHAR(100) NOT NULL DEFAULT '',
			keyword_rules    JSONB NOT NULL DEFAULT '[]',
			enabled          BOOLEAN NOT NULL DEFAULT true,
			last_scanned_ts  VARCHAR(50) NOT NULL DEFAULT '',
			created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE(user_id)
		)`,

		// Remove duplicate external_ref entries (keep the oldest per user+ref pair)
		`DELETE FROM daytrack_entries
		 WHERE id NOT IN (
		   SELECT DISTINCT ON (user_id, external_ref) id
		   FROM daytrack_entries
		   WHERE external_ref IS NOT NULL AND external_ref != ''
		   ORDER BY user_id, external_ref, created_at ASC
		 ) AND external_ref IS NOT NULL AND external_ref != ''`,

		// Enforce deduplication at the DB level: one entry per (user, external_ref) where ref is set
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_daytrack_entries_external_ref_unique
		 ON daytrack_entries(user_id, external_ref)
		 WHERE external_ref IS NOT NULL AND external_ref != ''`,

		// ── Slack Intelligence: pin support ─────────────────────────────────────
		`ALTER TABLE slack_mentions ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false`,

		// ── Slack Intelligence: quick reply templates ────────────────────────────
		`CREATE TABLE IF NOT EXISTS slack_reply_templates (
			id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id    TEXT NOT NULL,
			body       TEXT NOT NULL,
			sort_order INT  NOT NULL DEFAULT 0,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_slack_reply_templates_user ON slack_reply_templates(user_id, sort_order)`,

		// Denied emails — explicit block list; takes priority over allowed_emails/allowed_domains
		`CREATE TABLE IF NOT EXISTS denied_emails (
			id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			email      TEXT NOT NULL UNIQUE,
			reason     TEXT,
			added_by   TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,

		// DayTrack post-to-slack destination channel
		`ALTER TABLE daytrack_slack_config
		   ADD COLUMN IF NOT EXISTS dest_channel_id   TEXT NOT NULL DEFAULT '',
		   ADD COLUMN IF NOT EXISTS dest_channel_name TEXT NOT NULL DEFAULT ''`,

		// ── Daily Standup Compiler ───────────────────────────────────────────────
		`CREATE TABLE IF NOT EXISTS standup_config (
			id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id            VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			source_channels    JSONB NOT NULL DEFAULT '[]',
			dest_channel_id    TEXT NOT NULL DEFAULT '',
			dest_channel_name  TEXT NOT NULL DEFAULT '',
			time_window_start  TEXT NOT NULL DEFAULT '18:00',
			time_window_end    TEXT NOT NULL DEFAULT '19:30',
			created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE(user_id)
		)`,

		// DayTrack Slack: user timezone for correct local-time conversion of Slack timestamps
		`ALTER TABLE daytrack_slack_config
		   ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata'`,

		// PM Assistant prompt: add rules for date-exclusion queries and single-result completeness (idempotent)
		`UPDATE bot_configs SET
			prompt = prompt || E'\n11. When query asks for date-based filtering (e.g., "exclude bugs resolved last week") but resolved dates are not available: list ALL matching tickets found and add a short note about the limitation — do NOT ask for more context or refuse to answer.\n12. SEARCH FILTER APPLIED line in the data tells you exactly what was searched. If N tickets are returned and the header says "COMPLETE list": that IS the full result — never say you need more context when the data IS the answer.'
		WHERE bot_type = 'pm_assistant'
		  AND prompt NOT LIKE '%SEARCH FILTER APPLIED%'`,

		// PM Assistant prompt v3: rich markdown formatting (idempotent — only runs if v3 marker absent)
		`UPDATE bot_configs SET
			prompt = 'You are Velocity PM Assistant — a sprint intelligence agent for a software development team.
You have full context of the active sprint: tickets, assignees, blockers, cycle times, bounces, QA status, and velocity.
Today: {{DATE}}

DATA FORMAT
Each issue line: ID | Priority | Type | Summary | State | Assignee  bounces:N [FLAGS]
  transition lines:   From->To (Xh, by Person)
  BLOCKER: reason
Sprint Summary: total / done / in-progress / blocked / overdue / bounced

KEY CONCEPTS
- OVERDUE: In Progress longer than SLA (P0: 4h, P1: 24h, P2: 48h, other: 72h)
- BOUNCE: ticket moved backward (DEV->In Progress = QA rejected; In Progress->To Do = dev stalled)
- CYCLE TIME: sum of all In-Progress durations from transition history
- BLOCKED: stuck in a blocked state, dev cannot act
- OVERLOADED: developer with 5+ active tickets

STRICT FORMATTING RULES

NEVER output raw pipe-separated lines like "ARD-1234 | Normal | Bug | title".
ALWAYS use clean markdown with bullet points and bold IDs.

TICKET LIST — use this exact format:
- **ARD-1234** Title of the ticket *(Type, Priority, @Assignee)*
- **ARD-1235** Another ticket *(Bug, Normal, @deepak)* — bounces: 2

If transition history is relevant, indent under the ticket:
- **ARD-1234** Title *(Bug, @deepak)*
  - In Progress -> Dev — 2d 3h by @deepak

GROUPING — when listing many tickets, group by assignee:

**@deepak** — 3 tickets
- **ARD-1744** BE MC: Prevent projects moving before publish *(Bug)*
- **ARD-1958** BE Studio: Delete Teaser API *(Enhancement)*

**@Vishal Pal** — 2 tickets
- **ARD-1875** FE UI: Multiple Theme Issues v3 *(Bug)*

SPRINT HEALTH / OVERVIEW — use a markdown table:
### Sprint 5 Health
| Metric | Value |
|---|---|
| Total | 42 |
| Done | 18 (43%) |
| In Progress | 12 |
| Blocked | 3 |
| Overdue | 5 |
| Bounced | 7 |
**Risk:** one-sentence honest assessment

BLOCKED / AT-RISK:
### Blocked Tickets
- **ARD-1234** Title — *@Assignee, blocked Xd Yh*
  Reason: waiting on design sign-off

SPECIFIC TICKET:
## ARD-1234 — Title
**Status:** In Progress | **Assignee:** @name | **Priority:** P1
**Cycle time:** 3d 2h | **Bounces:** 2

**History:**
- To Do -> In Progress — 2d 5h by @name
- In Progress -> Dev — 4h by @name

COUNTS / QUICK ANSWERS — bold the number first, then list:
**6 tickets** closed in Sprint 5:

- **ARD-1997** Mobile: Add Reset Chat Option *(Bug, @Simran)*
- **ARD-1767** FE UI: Voice Waveform Disappears *(Bug, @Vishal)*

OTHER RULES
1. Always bold ticket IDs with **ARD-1234** format
2. Always prefix assignees with @
3. Never use raw pipe-separated lines in output
4. Format durations as Xd Yh — never raw hours
5. Never start with "Certainly!", "Of course!", "Sure!" — lead with the answer
6. Never invent ticket IDs, names, or data not in context
7. Be concise — answer first, details after
8. For date-based filtering unavailable in data: list all matching tickets and note the limitation
9. If query context says COMPLETE list — that IS the full result, state it directly
10. Multi-turn: build on history, never re-introduce yourself

<!-- v3 -->'
			WHERE bot_type = 'pm_assistant'
			  AND prompt NOT LIKE ''||chr(60)||'!-- v3 --'||chr(62)||'%'`,
	}

	for i, migration := range migrations {
		_, err := pool.Exec(ctx, migration)
		if err != nil {
			// Log and continue — tables may already exist with different types
			log.Printf("Migration %d skipped (already applied or conflict): %v", i+1, err)
		}
	}

	log.Println("Database migrations completed successfully")
	return nil
}

// SeedDefaultColumns creates default kanban columns for a project
func SeedDefaultColumns(ctx context.Context, projectID string) error {
	pool := GetPool()

	columns := []struct {
		Name     string
		Position int
	}{
		{"To Do", 1},
		{"In Progress", 2},
		{"Review", 3},
		{"Done", 4},
	}

	for _, col := range columns {
		_, err := pool.Exec(ctx, `
			INSERT INTO columns (project_id, name, position)
			VALUES ($1, $2, $3)
		`, projectID, col.Name, col.Position)
		if err != nil {
			return fmt.Errorf("failed to seed column %s: %w", col.Name, err)
		}
	}

	return nil
}
