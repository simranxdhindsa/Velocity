package handlers

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func dtMins(n int) *int { return &n }

func TestDayTrackTaskLines(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want []string
	}{
		{"single line stays whole", "Velocity: fixed the Chats AI buttons failing", []string{"Velocity: fixed the Chats AI buttons failing"}},
		{"newlines split 1-1-1", "fixed login\ntested signup\r\nreviewed PR", []string{"fixed login", "tested signup", "reviewed PR"}},
		{"bullets are stripped", "• Velocity: one\n- Velocity: two\n* Velocity: three", []string{"Velocity: one", "Velocity: two", "Velocity: three"}},
		{"numbered list", "1. first task\n2) second task", []string{"first task", "second task"}},
		{"checkboxes", "[ ] open item\n[x] closed item", []string{"open item", "closed item"}},
		{"inline bullets split", "• one thing • another thing", []string{"one thing", "another thing"}},
		{"semicolons split", "fixed login; tested signup;", []string{"fixed login", "tested signup"}},
		{"blank lines dropped", "\n  a task  \n\n\n", []string{"a task"}},
		{"inner whitespace collapsed", "fixed    the\tbug", []string{"fixed the bug"}},
		{"em dash removed", "fixed login — it was the token", []string{"fixed login, it was the token"}},
		{"double dash removed", "fixed login -- it was the token", []string{"fixed login, it was the token"}},
		{"cli flag keeps its dashes", "ran go test --race", []string{"ran go test --race"}},
		{"trailing double dash removed", "fixed it --", []string{"fixed it"}},
		{"leading double dash removed", "-- Velocity: lead dash", []string{"Velocity: lead dash"}},
		{"only a double dash is no task", "--", nil},
		{"hyphenated words untouched", "one-line reply box", []string{"one-line reply box"}},
		{"ticket prefix untouched", "ARD-3167: fixed deploy", []string{"ARD-3167: fixed deploy"}},
		{"control characters dropped", "fixed\x00 login", []string{"fixed login"}},
		{"nothing left", " \n - \n", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := mcpDayTrackTaskLines(c.raw); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %#v, want %#v", got, c.want)
			}
		})
	}
}

func TestParseDayTrackClock(t *testing.T) {
	good := map[string]int{
		"2pm": 840, "2 PM": 840, "2:30 PM": 870, "2:30pm": 870, "14:30": 870, "9.15am": 555,
		"12:00 AM": 0, "12 PM": 720, "12:30 am": 30, "00:05": 5, "23:59": 1439, "2 p.m.": 840,
	}
	for in, want := range good {
		got, err := mcpParseDayTrackClock(in, 600, true)
		if err != nil || got != want {
			t.Errorf("%q: got %d, %v, want %d", in, got, err, want)
		}
	}
	if got, err := mcpParseDayTrackClock("now", 600, true); err != nil || got != 600 {
		t.Errorf("now: got %d, %v", got, err)
	}
	if _, err := mcpParseDayTrackClock("now", 600, false); err == nil {
		t.Error("now on another day must be refused")
	}
	for _, in := range []string{"10", "25:00", "13:00 PM", "0:30 AM", "soon", "2:60 PM", "12:75"} {
		if _, err := mcpParseDayTrackClock(in, 600, true); err == nil {
			t.Errorf("%q should be refused", in)
		}
	}
}

func TestResolveDayTrackTimes(t *testing.T) {
	const now = 19 * 60 // 7:00 PM
	today := dayTrackClockContext{IsToday: true, NowMins: now, LatestEndMins: -1}
	chained := dayTrackClockContext{IsToday: true, NowMins: now, LatestEndMins: 17*60 + 30}
	batch := dayTrackClockContext{IsToday: true, NowMins: now, LatestEndMins: 17*60 + 30, Batch: true}
	pastDay := dayTrackClockContext{IsToday: false, LatestEndMins: -1}

	cases := []struct {
		name       string
		in         dayTrackClockInput
		ctx        dayTrackClockContext
		start, end string
		dur        *int
		source     string
	}{
		{"both given", dayTrackClockInput{Start: "2pm", End: "3:30pm"}, today, "2:00 PM", "3:30 PM", dtMins(90), "given"},
		{"same start and end is instant", dayTrackClockInput{Start: "2pm", End: "2pm"}, today, "2:00 PM", "2:00 PM", nil, "given"},
		{"given duration wins over span", dayTrackClockInput{Start: "9am", End: "12pm", DurationMins: dtMins(120)}, today, "9:00 AM", "12:00 PM", dtMins(120), "given"},
		{"start plus duration", dayTrackClockInput{Start: "2pm", DurationMins: dtMins(45)}, today, "2:00 PM", "2:45 PM", dtMins(45), "given"},
		{"end plus duration", dayTrackClockInput{End: "3pm", DurationMins: dtMins(30)}, today, "2:30 PM", "3:00 PM", dtMins(30), "given"},
		{"start only ends now", dayTrackClockInput{Start: "5pm"}, today, "5:00 PM", "7:00 PM", dtMins(120), "given"},
		{"start only on a past day has no end", dayTrackClockInput{Start: "5pm"}, pastDay, "5:00 PM", "", nil, "given"},
		{"end only chains from the last entry", dayTrackClockInput{End: "6pm"}, chained, "5:31 PM", "6:00 PM", dtMins(29), "chained"},
		{"end only with no earlier entry is instant", dayTrackClockInput{End: "6pm"}, today, "6:00 PM", "6:00 PM", nil, "given"},
		{"duration only ends now", dayTrackClockInput{DurationMins: dtMins(60)}, today, "6:00 PM", "7:00 PM", dtMins(60), "given"},
		{"duration only on a past day keeps times blank", dayTrackClockInput{DurationMins: dtMins(60)}, pastDay, "", "", dtMins(60), "given"},
		{"nothing given chains from last end to now", dayTrackClockInput{}, chained, "5:31 PM", "7:00 PM", dtMins(89), "chained"},
		{"nothing given and nothing logged stamps now", dayTrackClockInput{}, today, "7:00 PM", "7:00 PM", nil, "logged_at"},
		{"several tasks stamp now with no duration", dayTrackClockInput{}, batch, "7:00 PM", "7:00 PM", nil, "logged_at"},
		{"several tasks keep a given duration", dayTrackClockInput{DurationMins: dtMins(30)}, batch, "7:00 PM", "7:00 PM", dtMins(30), "logged_at"},
		{"nothing given on a past day stays blank", dayTrackClockInput{}, pastDay, "", "", nil, "blank"},
		{"last end this same minute stamps now", dayTrackClockInput{}, dayTrackClockContext{IsToday: true, NowMins: now, LatestEndMins: now}, "7:00 PM", "7:00 PM", nil, "logged_at"},
		{"last end in the future stamps now", dayTrackClockInput{}, dayTrackClockContext{IsToday: true, NowMins: now, LatestEndMins: now + 60}, "7:00 PM", "7:00 PM", nil, "logged_at"},
		{"short overnight span is allowed", dayTrackClockInput{Start: "10pm", End: "1am"}, today, "10:00 PM", "1:00 AM", dtMins(180), "given"},
		{"end plus duration across midnight keeps its start", dayTrackClockInput{End: "12:30am", DurationMins: dtMins(60)}, pastDay, "11:30 PM", "12:30 AM", dtMins(60), "given"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := mcpResolveDayTrackTimes(c.in, c.ctx)
			if err != nil {
				t.Fatal(err)
			}
			if got.Start != c.start || got.End != c.end || got.Source != c.source {
				t.Fatalf("got %q to %q (%s), want %q to %q (%s)", got.Start, got.End, got.Source, c.start, c.end, c.source)
			}
			if !reflect.DeepEqual(got.DurationMins, c.dur) {
				t.Fatalf("duration %v, want %v", got.DurationMins, c.dur)
			}
		})
	}

	refused := []struct {
		name string
		in   dayTrackClockInput
		want string
	}{
		{"end long before start", dayTrackClockInput{Start: "2pm", End: "10am"}, "before"},
		{"bad start", dayTrackClockInput{Start: "10"}, "start_time"},
		{"bad end", dayTrackClockInput{End: "soon"}, "end_time"},
		{"zero duration", dayTrackClockInput{DurationMins: dtMins(0)}, "duration_mins"},
		{"negative duration", dayTrackClockInput{DurationMins: dtMins(-5)}, "duration_mins"},
		{"over a day", dayTrackClockInput{DurationMins: dtMins(1441)}, "duration_mins"},
		{"duration longer than today so far", dayTrackClockInput{DurationMins: dtMins(20 * 60)}, "today so far"},
	}
	for _, c := range refused {
		t.Run("refused "+c.name, func(t *testing.T) {
			_, err := mcpResolveDayTrackTimes(c.in, today)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("got %v, want an error mentioning %q", err, c.want)
			}
		})
	}

	t.Run("long automatic span warns", func(t *testing.T) {
		got, err := mcpResolveDayTrackTimes(dayTrackClockInput{}, dayTrackClockContext{IsToday: true, NowMins: now, LatestEndMins: 6*60 + 10})
		if err != nil || got.Start != "6:11 AM" || len(got.Warnings) != 1 {
			t.Fatalf("got %+v, %v", got, err)
		}
	})
	t.Run("time still ahead today warns", func(t *testing.T) {
		got, err := mcpResolveDayTrackTimes(dayTrackClockInput{Start: "8pm", End: "9pm"}, today)
		if err != nil || len(got.Warnings) != 1 {
			t.Fatalf("got %+v, %v", got, err)
		}
	})
}

func TestDetectDayTrackCategory(t *testing.T) {
	cats := []string{"Development", "Testing", "Meetings", "Breaks", "Review", "Research", "Sign In", "Sign Off", "Project Management", "Website Testing"}
	cases := []struct {
		text, want, source string
	}{
		// Real entries from the live log.
		{"Velocity: fixed opening a chat wiping its list preview", "Development", "detected"},
		{"Velocity: slimmer one-line reply box that stays on screen", "Development", "default"},
		{"Velocity: dot on Slack in the left nav when a new message arrives", "Development", "default"},
		{"ARD-3167: fixed the deployment checklist", "Development", "detected"},
		{"tested SCORM scraping on DEV and STAGE", "Testing", "detected"},
		{"verified publish flow on Studio-Web (ARD-1700)", "Testing", "detected"},
		{"gave KT to Rohit on Voiden", "Meetings", "detected"},
		// Fix verbs beat the word "bug".
		{"fixed login bug", "Development", "detected"},
		// The page's plain substring match would get these wrong.
		{"added back button to the header", "Development", "detected"},
		{"made the export available to members", "Development", "default"},
		{"fixed AWS S3 upload timeout", "Development", "detected"},
		{"checked AWS logs for the outage", "Development", "default"},
		{"Velocity: barcode scanner layout", "Development", "default"},
		{"latest Safari layout", "Development", "default"},
		// Team shorthand still works when it is the whole message.
		{"aws 15 min", "Breaks", "detected"},
		{"lunch break", "Breaks", "detected"},
		{"coffee", "Breaks", "detected"},
		{"signed in", "Sign In", "detected"},
		{"signing off", "Sign Off", "detected"},
		{"Standup with the team", "Meetings", "detected"},
		{"sprint planning", "Meetings", "detected"},
		{"researched pgvector indexes", "Research", "detected"},
		{"looked into the Groq rate limits", "Research", "detected"},
		{"reviewed PR for Chats", "Review", "detected"},
		{"code review for the Gantt branch", "Review", "detected"},
		// Custom categories only match when named.
		{"Website Testing: checked the pricing page", "Website Testing", "detected"},
		{"project management for Sprint 14", "Project Management", "detected"},
		{"", "Development", "default"},
	}
	for _, c := range cases {
		t.Run(c.text, func(t *testing.T) {
			got, source := mcpDetectDayTrackCategory(c.text, cats)
			if got != c.want || source != c.source {
				t.Fatalf("got %s (%s), want %s (%s)", got, source, c.want, c.source)
			}
		})
	}
}

func TestDetectDayTrackCategoryHonoursTheUsersList(t *testing.T) {
	if got, _ := mcpDetectDayTrackCategory("tested login", []string{"Development"}); got != "Development" {
		t.Fatalf("got %s: a category the user doesn't have must not be picked", got)
	}
	if got, source := mcpDetectDayTrackCategory("anything", nil); got != "General" || source != "default" {
		t.Fatalf("got %s (%s), want the General fallback", got, source)
	}
}

func TestDayTrackAddOutcomeNeverHidesAFailure(t *testing.T) {
	details := map[string]interface{}{"created": []string{"saved"}, "failed": []string{"lost"}}
	summary, ok := mcpResultSummary(mcpDTAddOutcome(1, "2026-11-05", 1, 0, 1, details))
	if ok || !strings.Contains(summary, "Only 1 of 2") {
		t.Fatalf("a partial save must be an error, got ok=%v: %s", ok, summary)
	}
	summary, ok = mcpResultSummary(mcpDTAddOutcome(1, "2026-11-05", 2, 1, 0, map[string]interface{}{}))
	if !ok || summary != "Added 2 Day Track entries for 2026-11-05. Skipped 1 already logged." {
		t.Fatalf("got ok=%v: %s", ok, summary)
	}
}

func TestDayTrackArgsErrorIsReadable(t *testing.T) {
	var a struct {
		Entries []mcpDTAddInput `json:"entries"`
	}
	cases := map[string]string{
		`{"entries":[{"name":"x","duration_mins":"30"}]}`: "entries.duration_mins must be a whole number",
		`{"entries":[{"name":"x","duration_mins":2.5}]}`:  "entries.duration_mins must be a whole number",
		`{"entries":"nope"}`:                              "entries must be a list",
		`{"entries":[{"name":123}]}`:                      "entries.name must be text",
		`[1]`:                                             "arguments must be an object",
	}
	for in, want := range cases {
		msg := mcpDTArgsError(json.Unmarshal([]byte(in), &a))
		if !strings.Contains(msg, want) {
			t.Errorf("%s: got %q, want %q", in, msg, want)
		}
		if strings.Contains(msg, "mcpDT") || strings.Contains(msg, "struct") || strings.Contains(msg, "unmarshal") {
			t.Errorf("%s: Go internals in %q", in, msg)
		}
	}
}

func TestMatchDayTrackCategory(t *testing.T) {
	cats := []string{"Development", "Project Management"}
	if got, ok := mcpMatchDayTrackCategory(" project management ", cats); !ok || got != "Project Management" {
		t.Fatalf("got %q, %v", got, ok)
	}
	if _, ok := mcpMatchDayTrackCategory("Devops", cats); ok {
		t.Fatal("an unknown category must not match")
	}
}
