package database

import (
	"context"
	"os"
	"sync"
	"testing"

	"github.com/dhindsa/project-management/internal/models"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Opt-in: runs against the Postgres in TEST_DATABASE_URL (a throwaway one, never a real database).
func newTestBotRepo(t *testing.T) (*BotConfigRepository, context.Context) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL to a throwaway Postgres to run")
	}
	ctx := context.Background()
	p, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	old := pool
	pool = p
	t.Cleanup(func() { pool = old; p.Close() })
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS bot_configs (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name VARCHAR(255) NOT NULL, description TEXT,
			bot_type VARCHAR(50) NOT NULL, prompt TEXT NOT NULL, variables TEXT, is_active BOOLEAN DEFAULT TRUE,
			created_by VARCHAR(255), created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_configs_system_key ON bot_configs(created_by) WHERE created_by LIKE 'system:%'`,
		`DELETE FROM bot_configs WHERE bot_type = 'test_system'`,
	} {
		if _, err := p.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	return NewBotConfigRepository(), ctx
}

const testBotType = models.BotType("test_system")

func testBot(prompt string) *models.BotConfig {
	return &models.BotConfig{Name: "Seeded", Description: "d", BotType: testBotType, Prompt: prompt, Variables: "[]", IsActive: true, CreatedBy: "system:test:one"}
}

func onlyBot(t *testing.T, r *BotConfigRepository, ctx context.Context) *models.BotConfig {
	t.Helper()
	got, err := r.GetByType(ctx, testBotType)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("want exactly one bot, got %d", len(got))
	}
	return got[0]
}

func TestEnsureSystemBotSurvivesRenameAndEdits(t *testing.T) {
	r, ctx := newTestBotRepo(t)
	for i := 0; i < 2; i++ { // a restart must not add a second row
		if err := r.EnsureSystemBot(ctx, testBot("v1"), "v0"); err != nil {
			t.Fatal(err)
		}
	}
	b := onlyBot(t, r, ctx)
	b.Name, b.Prompt = "Renamed by admin", "edited by admin"
	if err := r.Update(ctx, b); err != nil {
		t.Fatal(err)
	}
	if err := r.EnsureSystemBot(ctx, testBot("v2"), "v1"); err != nil {
		t.Fatal(err)
	}
	if b = onlyBot(t, r, ctx); b.Name != "Renamed by admin" || b.Prompt != "edited by admin" || b.CreatedBy != "system:test:one" {
		t.Errorf("admin's rename or edit was lost: %+v", b)
	}
}

func TestEnsureSystemBotUpgradesAnUntouchedPrompt(t *testing.T) {
	r, ctx := newTestBotRepo(t)
	if err := r.EnsureSystemBot(ctx, testBot("v1"), "v0"); err != nil {
		t.Fatal(err)
	}
	if err := r.EnsureSystemBot(ctx, testBot("v2"), "v1"); err != nil {
		t.Fatal(err)
	}
	if b := onlyBot(t, r, ctx); b.Prompt != "v2" {
		t.Errorf("untouched prompt not upgraded: %q", b.Prompt)
	}
}

// Rows from the first release were seeded with created_by 'system' and no key.
func TestEnsureSystemBotAdoptsARowSeededBeforeKeys(t *testing.T) {
	r, ctx := newTestBotRepo(t)
	legacy := testBot("v1")
	legacy.CreatedBy = "system"
	if err := r.Create(ctx, legacy); err != nil {
		t.Fatal(err)
	}
	if err := r.EnsureSystemBot(ctx, testBot("v2"), "v1"); err != nil {
		t.Fatal(err)
	}
	if b := onlyBot(t, r, ctx); b.CreatedBy != "system:test:one" || b.Prompt != "v2" {
		t.Errorf("legacy row not adopted: %+v", b)
	}
}

// Two servers starting together must still leave one row.
func TestEnsureSystemBotConcurrentStartup(t *testing.T) {
	r, ctx := newTestBotRepo(t)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := r.EnsureSystemBot(ctx, testBot("v1"), "v0"); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	onlyBot(t, r, ctx)
}
