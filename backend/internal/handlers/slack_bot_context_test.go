package handlers

import (
	"strings"
	"testing"
)

func TestUniqueTicketIDs(t *testing.T) {
	got := uniqueTicketIDs("ARD-1 and APY-22, again ARD-1, not GPT 5 or x-1", 8)
	if strings.Join(got, ",") != "ARD-1,APY-22" {
		t.Fatalf("got %v", got)
	}
	if len(uniqueTicketIDs("A1-1 B2-2 C3-3", 2)) != 2 {
		t.Fatal("max not respected")
	}
}

func TestFramedUserText(t *testing.T) {
	if (slackBotContext{}).framedUserText("hi") != "hi" {
		t.Fatal("no frame should leave text unchanged")
	}
	c := slackBotContext{ThreadFrame: "(Context: x)"}
	if got := c.framedUserText("what is this?"); !strings.HasPrefix(got, "(Context: x)") || !strings.HasSuffix(got, "what is this?") {
		t.Fatalf("got %q", got)
	}
}

func TestSystemPromptWithContext(t *testing.T) {
	base := "persona"
	if systemPromptWithContext(base, slackBotContext{}) != base {
		t.Fatal("empty context must not change the prompt")
	}
	p := systemPromptWithContext(base, slackBotContext{
		SenderName: "Simran",
		History:    []groqMessage{{Role: "assistant", Content: "x"}},
		Notes:      []string{"note one"},
	}, "## Knowledge")
	for _, want := range []string{"persona", "## Conversation context", "You are talking to Simran.", "note one", "NOT a vague", "## Knowledge"} {
		if !strings.Contains(p, want) {
			t.Fatalf("missing %q in %q", want, p)
		}
	}
}
