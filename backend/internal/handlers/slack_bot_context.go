package handlers

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strings"
	"time"

	"github.com/dhindsa/project-management/internal/database"
	slacksvc "github.com/dhindsa/project-management/internal/services/slack"
)

// Conversation memory for the Slack bot. Slack itself is the memory: before
// each reply the bot re-reads the thread (or, in a DM, the last few hours of
// top-level messages) and replays it to the model as prior turns. Nothing is
// stored on our side, so it can never drift from what people actually see,
// and messages Velocity sent via Claude/MCP show up as the bot's own earlier
// turns automatically.

const (
	slackCtxMaxMessages  = 30              // most messages fetched per reply
	slackCtxCharBudget   = 12000           // ~3k tokens of history, newest kept first
	slackCtxMsgMaxChars  = 1500            // per message cap
	slackCtxRootMax      = 3000            // thread root cap (often a long MCP-sent update)
	slackCtxDMWindow     = 6 * time.Hour   // DM history window when not in a thread
	slackCtxDMAlwaysKeep = 6               // latest DM messages kept regardless of age
	slackCtxFetchTimeout = 8 * time.Second // never let history fetching stall a reply
)

var slackTicketIDRe = regexp.MustCompile(`\b[A-Z][A-Z0-9]{1,9}-\d+\b`)

// slackBotContext is what the bot knows about the conversation before
// answering: prior turns plus extra notes for the system prompt.
type slackBotContext struct {
	History    []groqMessage
	Notes      []string // appended to the system prompt under "Conversation context"
	SenderName string
	// ThreadFrame is prepended to the incoming message when replying inside
	// a thread. It sits on the final turn (not the system prompt) because
	// the small model weighs the last message far more than the system text.
	ThreadFrame string
}

// framedUserText is the incoming message as the model should see it.
func (c slackBotContext) framedUserText(text string) string {
	if c.ThreadFrame == "" {
		return text
	}
	return c.ThreadFrame + "\n\n" + text
}

// buildSlackBotContext reads the conversation around ev. Every failure is
// non-fatal (missing scope, rate limit): the bot then just answers the single
// message like it did before memory existed.
func buildSlackBotContext(ctx context.Context, client *slacksvc.Client, ev slackInnerEvent) slackBotContext {
	ctx, cancel := context.WithTimeout(ctx, slackCtxFetchTimeout)
	defer cancel()

	out := slackBotContext{}
	reader := &slackReader{
		client:      client,
		usersLoaded: true, // resolve the few authors via users.info, skip users.list
		users:       map[string]string{},
		bots:        map[string]string{},
		channels:    map[string]string{},
	}
	if ev.User != "" {
		out.SenderName = reader.userName(ctx, ev.User)
	}

	me, err := client.BotIdentity(ctx)
	if err != nil {
		log.Printf("[slack-events] context: auth.test failed, replying without history: %v", err)
		return out
	}

	isDM := ev.ChannelType == "im"
	var msgs []slacksvc.Message // oldest first
	inThread := ev.ThreadTS != "" && ev.ThreadTS != ev.TS
	switch {
	case inThread:
		msgs, err = client.GetThreadPaged(ctx, ev.Channel, ev.ThreadTS, 200)
		if len(msgs) > slackCtxMaxMessages {
			// Keep the root (what the thread is about) plus the newest replies.
			msgs = append([]slacksvc.Message{msgs[0]}, msgs[len(msgs)-slackCtxMaxMessages+1:]...)
		}
	case isDM:
		var newestFirst []slacksvc.Message
		latest := slackTSUnix(ev.TS)
		if latest == 0 {
			latest = time.Now().Unix()
		}
		// The last few messages are always kept, however old: a reply is
		// about whatever came right before it. Measured live: "what is this"
		// three days after a "New ticket assigned to you: ARD-3033" DM got no
		// history at all from a time window alone, and a clueless reply.
		// Beyond those, only messages within slackCtxDMWindow are added.
		newestFirst, _, err = client.GetHistoryPaged(ctx, ev.Channel, 0, latest, slackCtxMaxMessages)
		oldest := latest - int64(slackCtxDMWindow/time.Second)
		kept := 0
		for i, m := range newestFirst {
			if i >= slackCtxDMAlwaysKeep && slackTSUnix(m.TS) < oldest {
				break
			}
			kept = i + 1
		}
		newestFirst = newestFirst[:kept]
		for i := len(newestFirst) - 1; i >= 0; i-- {
			msgs = append(msgs, newestFirst[i])
		}
		// Say how old the context is, so a days-old message is not treated
		// as if it was just said.
		// newestFirst ends before ev.TS (latest bound), so [0] is the
		// message right before the one being answered.
		if len(newestFirst) > 0 {
			prev := newestFirst[0]
			if prev.TS == ev.TS && len(newestFirst) > 1 {
				prev = newestFirst[1]
			}
			if gap := latest - slackTSUnix(prev.TS); prev.TS != ev.TS && gap > int64(slackCtxDMWindow/time.Second) {
				out.Notes = append(out.Notes, "The message before this one was sent "+humanGap(gap)+" ago, so this may be a late reply to it.")
			}
		}
	default:
		// A fresh @mention in a channel: no history on purpose, so the bot
		// never pulls unrelated channel chatter into a reply.
		return out
	}
	if err != nil {
		log.Printf("[slack-events] context: history fetch failed for %s: %v", ev.Channel, err)
	}

	isOwn := func(m slacksvc.Message) bool {
		return (me.UserID != "" && m.User == me.UserID) || (me.BotID != "" && m.BotID == me.BotID)
	}

	// Turn Slack messages into chat turns, skipping the message being answered.
	type turn struct {
		msg  groqMessage
		size int
		root bool
	}
	var turns []turn
	var lastOwn *slacksvc.Message
	for i := range msgs {
		m := msgs[i]
		if m.TS == ev.TS || (m.Subtype != "" && m.Subtype != "bot_message" && m.Subtype != "thread_broadcast") {
			continue
		}
		text := slackMessagePlainText(ctx, reader, m)
		if strings.TrimSpace(text) == "" {
			continue
		}
		isRoot := inThread && i == 0
		limit := slackCtxMsgMaxChars
		if isRoot {
			limit = slackCtxRootMax
		}
		text = truncateText(text, limit)
		var gm groqMessage
		if isOwn(m) {
			gm = groqMessage{Role: "assistant", Content: text}
			lastOwn = &msgs[i]
		} else {
			name, isBot := reader.author(ctx, m)
			if isBot {
				name += " (app)"
			}
			if isDM && !isBot {
				gm = groqMessage{Role: "user", Content: text} // one human in a DM, no label needed
			} else {
				gm = groqMessage{Role: "user", Content: name + ": " + text}
			}
		}
		turns = append(turns, turn{msg: gm, size: len(gm.Content), root: isRoot})
	}

	// Fit the budget from the newest end, always keeping a thread root.
	budget := slackCtxCharBudget
	keep := make([]bool, len(turns))
	for i := len(turns) - 1; i >= 0; i-- {
		if turns[i].root || turns[i].size <= budget {
			keep[i] = true
			budget -= turns[i].size
		}
	}
	dropped := 0
	for i, t := range turns {
		if keep[i] {
			out.History = append(out.History, t.msg)
		} else {
			dropped++
		}
	}
	if dropped > 0 {
		out.Notes = append(out.Notes, fmt.Sprintf("%d older messages in this conversation were left out for length.", dropped))
	}

	// Point the model at what a thread is about, so a bare "what is this?"
	// resolves to the root instead of the last small-talk reply.
	if inThread && len(msgs) > 0 && msgs[0].TS != ev.TS {
		who := "someone"
		if isOwn(msgs[0]) {
			who = "you"
		} else if n, _ := reader.author(ctx, msgs[0]); n != "" {
			who = n
		}
		rootText := truncateText(strings.ReplaceAll(slackMessagePlainText(ctx, reader, msgs[0]), "\n", " "), 300)
		out.ThreadFrame = fmt.Sprintf(
			"(Context: this message is a reply in a Slack thread that %s started with: %q. Words like this, it, or that refer to that thread starter unless clearly about something else.)",
			who, rootText)
	}

	// Where did the message being replied to come from? In a thread that is
	// the root; in a DM it is the bot's most recent message.
	var anchor *slacksvc.Message
	if inThread && len(msgs) > 0 && isOwn(msgs[0]) {
		anchor = &msgs[0]
	} else if !inThread && lastOwn != nil {
		anchor = lastOwn
	}
	if anchor != nil {
		if note := slackOriginNote(ctx, ev.Channel, *anchor, slackMessagePlainText(ctx, reader, *anchor)); note != "" {
			out.Notes = append(out.Notes, note)
		}
	}
	return out
}

// slackOriginNote explains a bot-authored message using Velocity's send logs
// plus any ticket IDs it mentions, so a reply like "what is this?" can be
// answered from facts (and the bot knows which tickets to look up).
func slackOriginNote(ctx context.Context, channelID string, m slacksvc.Message, text string) string {
	var parts []string
	if o := database.FindSlackMessageOrigin(ctx, channelID, m.TS); o != nil {
		how := "by Velocity's " + strings.ReplaceAll(o.Source, "_", " ") + " feature"
		if o.Source == "claude_queue" {
			how = "through Claude (the Velocity MCP connector)"
		}
		who := ""
		if o.SenderName != "" {
			who = " on behalf of " + o.SenderName
		}
		parts = append(parts, fmt.Sprintf("Your earlier message being discussed was sent %s%s on %s.",
			how, who, o.SentAt.Format("Jan 2")))
		if text == "" {
			text = o.Message
		}
	}
	if ids := uniqueTicketIDs(text, 8); len(ids) > 0 {
		parts = append(parts, "It mentions tickets "+strings.Join(ids, ", ")+
			". If asked what it is about, look them up with get_ticket instead of guessing.")
	}
	return strings.Join(parts, " ")
}

// slackMessagePlainText is a message's readable text: resolved mentions and
// links, plus attachment fallbacks (apps like YouTrack post their content
// there rather than in text).
func slackMessagePlainText(ctx context.Context, r *slackReader, m slacksvc.Message) string {
	text := r.resolveText(ctx, m.Text)
	for _, a := range m.Attachments {
		fb := strings.TrimSpace(a.Fallback)
		if fb == "[no preview available]" {
			continue // Slack's placeholder for block-only messages, not content
		}
		if fb != "" && !strings.Contains(text, fb) {
			text = strings.TrimSpace(text + "\n" + fb)
		}
	}
	for _, f := range m.Files {
		name := f.Title
		if name == "" {
			name = f.Name
		}
		text = strings.TrimSpace(text + "\n[shared file: " + name + "]")
	}
	return text
}

func uniqueTicketIDs(text string, max int) []string {
	seen := map[string]bool{}
	var ids []string
	for _, id := range slackTicketIDRe.FindAllString(text, -1) {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
			if len(ids) == max {
				break
			}
		}
	}
	return ids
}

// slackTSUnix turns a Slack ts ("1791400680.956699") into Unix seconds,
// 0 when unparseable (meaning "no upper bound").
func slackTSUnix(ts string) int64 {
	t := slackTSTime(ts)
	if t.IsZero() {
		return 0
	}
	return t.Unix()
}

// systemPromptWithContext appends conversation notes and the sender's name
// to the persona prompt, kept clearly separate from the persona rules.
func systemPromptWithContext(base string, c slackBotContext, extra ...string) string {
	var b strings.Builder
	b.WriteString(base)
	notes := append([]string{}, c.Notes...)
	if c.SenderName != "" && c.SenderName != "unknown user" {
		notes = append([]string{"You are talking to " + c.SenderName + "."}, notes...)
	}
	if len(c.History) > 0 || c.ThreadFrame != "" {
		notes = append(notes,
			"The earlier messages are the real conversation so far. Use them to understand follow-ups like \"what is this\" or \"and the other one\", and dont repeat yourself.",
			"A short follow-up such as \"what is this?\" or \"why?\" is NOT a vague or low-effort message when there is earlier context. Answer it from that context first, the joke comes second.")
	}
	if len(notes) > 0 {
		b.WriteString("\n\n## Conversation context\n\n")
		for _, n := range notes {
			b.WriteString("- " + n + "\n")
		}
	}
	for _, e := range extra {
		if strings.TrimSpace(e) != "" {
			b.WriteString("\n\n" + e)
		}
	}
	return b.String()
}

// humanGap renders a duration in seconds as "3 days" / "5 hours".
func humanGap(sec int64) string {
	h := sec / 3600
	if h >= 48 {
		return fmt.Sprintf("%d days", h/24)
	}
	if h >= 2 {
		return fmt.Sprintf("%d hours", h)
	}
	return fmt.Sprintf("%d minutes", sec/60)
}
