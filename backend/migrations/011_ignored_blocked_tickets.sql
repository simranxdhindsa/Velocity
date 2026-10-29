-- Per-user list of blocked tickets the user has chosen to "park" (hide from views)
CREATE TABLE IF NOT EXISTS user_ignored_blocked_tickets (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issue_id   VARCHAR(255) NOT NULL,
    ignored_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, issue_id)
);

CREATE INDEX IF NOT EXISTS idx_uibt_user ON user_ignored_blocked_tickets(user_id);
