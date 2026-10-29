package handlers

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode"

	youtrack "github.com/dhindsa/project-management/internal/services/youtrack"
)

// Text preprocessing for add/edit_youtrack_comment: Slack-style link
// conversion and @mention resolution to real YouTrack logins. Both only
// touch prose, never fenced code blocks or inline code spans.

// commentSegment is a run of comment text that is either prose or code.
type commentSegment struct {
	text   string
	isCode bool
}

var (
	fenceLineRe = regexp.MustCompile("^\\s{0,3}(`{3,}|~{3,})")
	inlineCode  = regexp.MustCompile("`+[^`\n]*`+")
	// <https://x|label> and <mailto:a@b|label>, Slack's link syntax.
	slackLinkRe = regexp.MustCompile(`<((?:https?://|mailto:)[^|>\s]+)\|([^>\n]+)>`)
	// Permalink form: ...#focus=Comments-4-123.0-0
	commentPermalinkRe = regexp.MustCompile(`Comments-(\d+-\d+)\.`)
)

// splitCommentSegments separates fenced code blocks and inline code spans
// from prose so transforms never rewrite code.
func splitCommentSegments(text string) []commentSegment {
	var segs []commentSegment
	addProse := func(s string) {
		if s == "" {
			return
		}
		last := 0
		for _, loc := range inlineCode.FindAllStringIndex(s, -1) {
			if loc[0] > last {
				segs = append(segs, commentSegment{text: s[last:loc[0]]})
			}
			segs = append(segs, commentSegment{text: s[loc[0]:loc[1]], isCode: true})
			last = loc[1]
		}
		if last < len(s) {
			segs = append(segs, commentSegment{text: s[last:]})
		}
	}

	lines := strings.SplitAfter(text, "\n")
	var prose, code strings.Builder
	fence := ""
	for _, line := range lines {
		if fence == "" {
			if m := fenceLineRe.FindStringSubmatch(line); m != nil {
				addProse(prose.String())
				prose.Reset()
				fence = m[1][:1]
				code.WriteString(line)
				continue
			}
			prose.WriteString(line)
			continue
		}
		code.WriteString(line)
		if m := fenceLineRe.FindStringSubmatch(line); m != nil && m[1][:1] == fence && strings.TrimSpace(line) == strings.TrimSpace(m[0]) {
			segs = append(segs, commentSegment{text: code.String(), isCode: true})
			code.Reset()
			fence = ""
		}
	}
	if code.Len() > 0 { // unclosed fence: treat the rest as code
		segs = append(segs, commentSegment{text: code.String(), isCode: true})
	}
	addProse(prose.String())
	return segs
}

func joinSegments(segs []commentSegment) string {
	var b strings.Builder
	for _, s := range segs {
		b.WriteString(s.text)
	}
	return b.String()
}

// convertSlackLinks rewrites Slack `<url|label>` links to Markdown
// `[label](url)`. Returns the new text and how many links were converted.
func convertSlackLinks(prose string) (string, int) {
	n := 0
	out := slackLinkRe.ReplaceAllStringFunc(prose, func(m string) string {
		sub := slackLinkRe.FindStringSubmatch(m)
		n++
		return "[" + strings.TrimSpace(sub[2]) + "](" + sub[1] + ")"
	})
	return out, n
}

// ytPerson is one mention target: a real YouTrack login and every name it
// may be referred to by.
type ytPerson struct {
	login string
	names []string // full names, lowercased
}

type mentionDirectory struct {
	people []*ytPerson
	source string
}

// loadMentionDirectory builds the login/name directory from YouTrack users,
// enriched with Velocity's developer configs (Integrations > Developers).
// Developer-config logins that YouTrack doesn't know are dropped when the
// YouTrack user list is available.
func loadMentionDirectory(ctx context.Context, yt *youtrack.Client) *mentionDirectory {
	d := &mentionDirectory{}
	byLogin := map[string]*ytPerson{}
	add := func(login, name string) *ytPerson {
		key := strings.ToLower(login)
		p := byLogin[key]
		if p == nil {
			p = &ytPerson{login: login}
			byLogin[key] = p
			d.people = append(d.people, p)
		}
		if n := strings.ToLower(strings.Join(strings.Fields(name), " ")); n != "" {
			for _, existing := range p.names {
				if existing == n {
					return p
				}
			}
			p.names = append(p.names, n)
		}
		return p
	}
	users, uErr := yt.GetUsers(ctx)
	for _, u := range users {
		if u.Login != "" {
			add(u.Login, u.FullName)
		}
	}
	if configs, err := devConfigRepo.GetAll(ctx); err == nil {
		for _, c := range configs {
			if c.DeveloperLogin == "" {
				continue
			}
			if uErr == nil && byLogin[strings.ToLower(c.DeveloperLogin)] == nil {
				continue
			}
			add(c.DeveloperLogin, c.DeveloperName)
		}
	}
	switch {
	case uErr == nil:
		d.source = "youtrack_users+developer_configs"
	default:
		d.source = "developer_configs_only (YouTrack user list failed: " + uErr.Error() + ")"
	}
	return d
}

func (d *mentionDirectory) byLogin(s string) *ytPerson {
	for _, p := range d.people {
		if strings.EqualFold(p.login, s) {
			return p
		}
	}
	return nil
}

// match returns people whose full name equals s, or (when firstName is set)
// whose first name equals s.
func (d *mentionDirectory) match(s string, firstName bool) []*ytPerson {
	s = strings.ToLower(s)
	var out []*ytPerson
	for _, p := range d.people {
		for _, n := range p.names {
			if n == s || (firstName && strings.SplitN(n, " ", 2)[0] == s) {
				out = append(out, p)
				break
			}
		}
	}
	return out
}

type mentionResult struct {
	Written string `json:"written"`
	Login   string `json:"login"`
	Matched string `json:"matched_by"`
	Rewrote bool   `json:"rewritten"`
}

func isLoginRune(r byte) bool {
	return r == '.' || r == '_' || r == '-' || r < 128 && (unicode.IsLetter(rune(r)) || unicode.IsDigit(rune(r)))
}

func loginsOf(ps []*ytPerson) string {
	ls := make([]string, 0, len(ps))
	for _, p := range ps {
		ls = append(ls, "@"+p.login)
	}
	sort.Strings(ls)
	return strings.Join(ls, ", ")
}

var mentionWordRe = regexp.MustCompile(`^ ([A-Za-z][A-Za-z'-]*)`)

// resolveMentions rewrites `@Display Name`, `@{Display Name}` and `@firstname`
// to `@login` in one prose segment. Real logins are kept (only their case is
// normalised). Emails and URL paths are skipped because the `@` follows a
// word character or `/`. Unknown or ambiguous mentions are left untouched
// and reported in warnings.
func (d *mentionDirectory) resolveMentions(prose string, results *[]mentionResult, warnings *[]string) string {
	var b strings.Builder
	i := 0
	for i < len(prose) {
		at := strings.IndexByte(prose[i:], '@')
		if at < 0 {
			b.WriteString(prose[i:])
			break
		}
		at += i
		b.WriteString(prose[i:at])
		i = at + 1
		if at > 0 {
			prev := prose[at-1]
			if isLoginRune(prev) || prev == '@' || prev == '/' || prev == '`' {
				b.WriteByte('@')
				continue
			}
		}

		// @{Display Name}
		if i < len(prose) && prose[i] == '{' {
			end := strings.IndexByte(prose[i:], '}')
			if end > 1 {
				name := strings.TrimSpace(prose[i+1 : i+end])
				written := prose[at : i+end+1]
				if p := d.byLogin(name); p != nil {
					b.WriteString("@" + p.login)
					*results = append(*results, mentionResult{written, p.login, "login", true})
				} else if ps := d.match(name, false); len(ps) == 1 {
					b.WriteString("@" + ps[0].login)
					*results = append(*results, mentionResult{written, ps[0].login, "full_name", true})
				} else if ps := d.match(name, true); len(ps) == 1 {
					b.WriteString("@" + ps[0].login)
					*results = append(*results, mentionResult{written, ps[0].login, "first_name", true})
				} else {
					b.WriteString(written)
					*warnings = append(*warnings, mentionWarning(written, d.match(name, true)))
				}
				i += end + 1
				continue
			}
		}

		j := i
		for j < len(prose) && isLoginRune(prose[j]) {
			j++
		}
		token := strings.TrimRight(prose[i:j], ".-_")
		j = i + len(token)
		if token == "" {
			b.WriteByte('@')
			continue
		}

		// Longest multi-word full name first: "@Deepak Kumar".
		words := []string{token}
		ends := []int{j}
		k := j
		for n := 0; n < 3; n++ {
			m := mentionWordRe.FindStringSubmatch(prose[k:])
			if m == nil {
				break
			}
			words = append(words, m[1])
			k += len(m[0])
			ends = append(ends, k)
		}
		done := false
		for n := len(words); n >= 2; n-- {
			if ps := d.match(strings.Join(words[:n], " "), false); len(ps) == 1 {
				b.WriteString("@" + ps[0].login)
				*results = append(*results, mentionResult{prose[at:ends[n-1]], ps[0].login, "full_name", true})
				i = ends[n-1]
				done = true
				break
			}
		}
		if done {
			continue
		}

		written := "@" + token
		i = j
		if p := d.byLogin(token); p != nil {
			b.WriteString("@" + p.login)
			*results = append(*results, mentionResult{written, p.login, "login", p.login != token})
			continue
		}
		if ps := d.match(token, false); len(ps) == 1 {
			b.WriteString("@" + ps[0].login)
			*results = append(*results, mentionResult{written, ps[0].login, "full_name", true})
			continue
		}
		ps := d.match(token, true)
		if len(ps) == 1 {
			b.WriteString("@" + ps[0].login)
			*results = append(*results, mentionResult{written, ps[0].login, "first_name", true})
			continue
		}
		b.WriteString(written)
		*warnings = append(*warnings, mentionWarning(written, ps))
	}
	return b.String()
}

func mentionWarning(written string, candidates []*ytPerson) string {
	if len(candidates) > 1 {
		return fmt.Sprintf("%s is ambiguous (%s), left as written. Use the exact login.", written, loginsOf(candidates))
	}
	return fmt.Sprintf("%s is not a known YouTrack user, left as written.", written)
}

// commentTextReport describes what preprocessing changed.
type commentTextReport struct {
	Mentions        []mentionResult `json:"mentions,omitempty"`
	MentionWarnings []string        `json:"mention_warnings,omitempty"`
	SlackLinks      int             `json:"slack_links_converted,omitempty"`
	DirectorySource string          `json:"mention_directory,omitempty"`
}

// prepareCommentText applies Slack link conversion and mention resolution
// to the prose parts of text, leaving code untouched.
func prepareCommentText(ctx context.Context, yt *youtrack.Client, text string, resolve, convertSlack bool) (string, commentTextReport) {
	var rep commentTextReport
	segs := splitCommentSegments(text)
	var dir *mentionDirectory
	if resolve && strings.Contains(text, "@") {
		dir = loadMentionDirectory(ctx, yt)
		rep.DirectorySource = dir.source
	}
	for i := range segs {
		if segs[i].isCode {
			continue
		}
		if convertSlack {
			var n int
			segs[i].text, n = convertSlackLinks(segs[i].text)
			rep.SlackLinks += n
		}
		if dir != nil {
			segs[i].text = dir.resolveMentions(segs[i].text, &rep.Mentions, &rep.MentionWarnings)
		}
	}
	return joinSegments(segs), rep
}

// parseCommentID accepts a raw comment ID ("4-123") or a comment permalink.
func parseCommentID(s string) string {
	s = strings.TrimSpace(s)
	if m := commentPermalinkRe.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return s
}
