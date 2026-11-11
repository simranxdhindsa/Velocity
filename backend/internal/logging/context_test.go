package logging

import (
	"context"
	"testing"
)

func TestDetachKeepsIDNotCancel(t *testing.T) {
	in := &info{id: "abcdefgh1"}
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), infoKey, in))
	SetUser(ctx, "u9")
	d := Detach(ctx)
	cancel()
	if d.Err() != nil {
		t.Error("detached ctx cancelled")
	}
	if RequestID(d) != "abcdefgh1" || getInfo(d).userID != "u9" {
		t.Error("id/user lost")
	}
	if getInfo(d) == in {
		t.Error("expected a copy")
	}
}

func TestNoopWithoutInfo(t *testing.T) {
	ctx := context.Background()
	SetUser(ctx, "x")
	SetRoute(ctx, "/x")
	AddField(ctx, "a", 1)
	if RequestID(ctx) != "" {
		t.Error("expected empty id")
	}
}

func TestNoTrace(t *testing.T) {
	if isNoTrace(context.Background()) || !isNoTrace(NoTrace(context.Background())) {
		t.Error("NoTrace wrong")
	}
}
