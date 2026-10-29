package handlers

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/dhindsa/project-management/internal/services/youtrack"
)

// Helpers for generate_deployment_report (mcp_tool_generate_deployment_report.go):
// exclusion filters and the AI fix-statement loop.

func deployUpperSet(vals []string) map[string]bool {
	out := map[string]bool{}
	for _, v := range vals {
		if v = strings.ToUpper(strings.TrimSpace(v)); v != "" {
			out[v] = true
		}
	}
	return out
}

func deployLowerSet(vals []string) map[string]string {
	out := map[string]string{}
	for _, v := range vals {
		if t := strings.TrimSpace(v); t != "" {
			out[strings.ToLower(t)] = t
		}
	}
	return out
}

// deploySummaryLine is the report text used when there is no AI fix
// statement. The report line already prints the subsystem, so a leading
// "FE UI:" (or "P2 BE UI:") prefix is dropped to avoid "FE UI: FE UI: ...".
func deploySummaryLine(summary, subsystem string) string {
	sub := strings.TrimSpace(subsystem)
	if sub == "" {
		return strings.TrimSpace(summary)
	}
	if i := strings.Index(strings.ToLower(summary), strings.ToLower(sub)+":"); i >= 0 && i <= 30 {
		if rest := strings.TrimSpace(summary[i+len(sub)+1:]); rest != "" {
			return rest
		}
	}
	return strings.TrimSpace(summary)
}

func deployNewTicket(issue youtrack.Issue) deployReportTicket {
	item := deployTicketItemFromIssue(issue)
	t := deployReportTicket{
		IDReadable: item.IDReadable,
		Summary:    item.Summary,
		State:      youtrack.GetStatus(issue),
		Type:       item.IssueType,
		Section:    deployCategory(item.IssueType),
		Subsystem:  item.Subsystem,
		item:       item,
	}
	if item.UpdatedAt > 0 {
		t.Updated = time.UnixMilli(item.UpdatedAt).Format(time.RFC3339)
	}
	return t
}

// deployApplyFilters applies include_ids, exclusions and the updated window.
// The first matching reason is recorded for each excluded ticket. Tickets in
// include_ids skip every exclusion and are fetched if not already in scope.
func deployApplyFilters(ctx context.Context, yt *youtrack.Client, issues []youtrack.Issue, a deployReportArgs, updated string) ([]deployReportTicket, []deployExcluded, []string) {
	var warnings []string
	include := deployUpperSet(a.IncludeIDs)
	excludeIDs := deployUpperSet(a.ExcludeIDs)
	subsystems := deployLowerSet(a.ExcludeSubsystems)
	types := deployLowerSet(a.ExcludeTypes)
	keywords := deployLowerSet(a.ExcludeKeywords)

	present := map[string]bool{}
	for _, iss := range issues {
		present[strings.ToUpper(iss.IDReadable)] = true
	}
	for idr := range include {
		if present[idr] {
			continue
		}
		iss, err := yt.GetIssue(ctx, idr)
		if err != nil || iss == nil {
			warnings = append(warnings, fmt.Sprintf("include_ids: %s not found", idr))
			continue
		}
		issues = append(issues, *iss)
		present[idr] = true
	}

	// Tags aren't on the issue payload, so resolve each tag to its ticket IDs.
	tagged := map[string]string{} // ID -> tag
	for _, tag := range a.ExcludeTags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		hits, err := yt.SearchIssues(ctx, fmt.Sprintf("project: %s tag: {%s}", yt.GetProjectID(), tag), 1000)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("exclude_tags: tag %q is not used in this project, ignored", tag))
			continue
		}
		for _, h := range hits {
			if _, ok := tagged[strings.ToUpper(h.IDReadable)]; !ok {
				tagged[strings.ToUpper(h.IDReadable)] = tag
			}
		}
	}

	now := time.Now()
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).UnixMilli()
	yestStart := time.Date(now.Year(), now.Month(), now.Day()-1, 0, 0, 0, 0, now.Location()).UnixMilli()

	used := map[string]bool{}
	var kept []deployReportTicket
	var excluded []deployExcluded
	for _, iss := range issues {
		t := deployNewTicket(iss)
		idr := strings.ToUpper(t.IDReadable)
		if include[idr] {
			t.Forced = true
			kept = append(kept, t)
			continue
		}
		reason := ""
		switch {
		case excludeIDs[idr]:
			reason, used["id:"+idr] = "exclude_ids: "+t.IDReadable, true
		case subsystems[strings.ToLower(t.Subsystem)] != "":
			v := subsystems[strings.ToLower(t.Subsystem)]
			reason, used["sub:"+strings.ToLower(v)] = "exclude_subsystems: Subsystem is "+t.Subsystem, true
		case types[strings.ToLower(t.Type)] != "":
			v := types[strings.ToLower(t.Type)]
			reason, used["type:"+strings.ToLower(v)] = "exclude_types: Type is "+t.Type, true
		case tagged[idr] != "":
			reason = "exclude_tags: tagged " + tagged[idr]
		}
		if reason == "" {
			low := strings.ToLower(t.Summary)
			for k, orig := range keywords {
				if strings.Contains(low, k) {
					reason, used["kw:"+k] = fmt.Sprintf("exclude_keywords: summary contains %q", orig), true
					break
				}
			}
		}
		if reason == "" && updated != "all" {
			u := t.item.UpdatedAt
			if updated == "today" && u < todayStart {
				reason = "updated: not updated today"
			} else if updated == "yesterday" && (u < yestStart || u >= todayStart) {
				reason = "updated: not updated yesterday"
			}
		}
		if reason != "" {
			excluded = append(excluded, deployExcluded{IDReadable: t.IDReadable, Summary: t.Summary, State: t.State, Subsystem: t.Subsystem, Type: t.Type, Reason: reason})
			continue
		}
		kept = append(kept, t)
	}

	for idr := range excludeIDs {
		if !used["id:"+idr] && !include[idr] {
			warnings = append(warnings, fmt.Sprintf("exclude_ids: %s was not in scope", idr))
		}
	}
	for k, orig := range subsystems {
		if !used["sub:"+k] {
			warnings = append(warnings, fmt.Sprintf("exclude_subsystems: no ticket in scope has Subsystem %q", orig))
		}
	}
	for k, orig := range types {
		if !used["type:"+k] {
			warnings = append(warnings, fmt.Sprintf("exclude_types: no ticket in scope has Type %q", orig))
		}
	}
	for k, orig := range keywords {
		if !used["kw:"+k] {
			warnings = append(warnings, fmt.Sprintf("exclude_keywords: no ticket in scope matched %q", orig))
		}
	}
	if kept == nil {
		kept = []deployReportTicket{}
	}
	if excluded == nil {
		excluded = []deployExcluded{}
	}
	return kept, excluded, warnings
}

const (
	deployAIWorkers     = 2
	deployAIAttempts    = 3
	deployAIBudget      = 100 * time.Second
	deployAIMaxRateWait = 30 * time.Second
)

// deployGenerateFixes writes an AI fix statement into each ticket, like the
// UI's Generate step (one AI call per ticket, waiting out rate limits).
// Tickets that still fail fall back to their summary and are returned.
func deployGenerateFixes(ctx context.Context, prompt string, tickets []deployReportTicket) []map[string]string {
	deadline := time.Now().Add(deployAIBudget)
	jobs := make(chan int)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var failed []map[string]string

	for w := 0; w < deployAIWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				t := &tickets[i]
				var lastErr error
				// Rate-limit waits don't use up an attempt; only the time budget caps them.
				for attempt := 0; attempt < deployAIAttempts && time.Now().Before(deadline) && ctx.Err() == nil; {
					fix, limited, retryAfter, err := generateDeploymentFixStatement(ctx, prompt, t.item)
					if err == nil && fix != "" {
						t.FixStatement, t.FixSource, lastErr = fix, "ai", nil
						break
					}
					lastErr = err
					if lastErr == nil {
						lastErr = fmt.Errorf("empty AI response")
					}
					if !limited {
						attempt++
					} else {
						wait := time.Duration(retryAfter) * time.Second
						if wait > deployAIMaxRateWait {
							wait = deployAIMaxRateWait
						}
						if time.Now().Add(wait).After(deadline) {
							break
						}
						select {
						case <-ctx.Done():
							attempt = deployAIAttempts
						case <-time.After(wait):
						}
					}
				}
				if t.FixSource != "ai" {
					if lastErr == nil {
						lastErr = fmt.Errorf("time budget exceeded")
					}
					t.FixStatement, t.FixSource = deploySummaryLine(t.item.Summary, t.Subsystem), "summary_fallback"
					mu.Lock()
					failed = append(failed, map[string]string{"id_readable": t.IDReadable, "error": lastErr.Error()})
					mu.Unlock()
				}
			}
		}()
	}
	for i := range tickets {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	return failed
}
