package handlers

import (
	"testing"

	"github.com/dhindsa/project-management/internal/database"
)

func TestDescribeSendDestination(t *testing.T) {
	channels := map[string]string{"C0B30MXMDHQ": "project-managers"}
	users := map[string]string{"U01ROHIT": "Rohit"}
	cases := []struct {
		row              database.PendingSlackMessage
		wantDest, wantRe string
	}{
		// Sent by raw ID, labelled with the bare ID in the queue: still shows the channel name
		{database.PendingSlackMessage{ChannelID: "C0B30MXMDHQ", ChannelLabel: "C0B30MXMDHQ"}, "#project-managers", "channel: 'project-managers'"},
		{database.PendingSlackMessage{DmUserID: "U01ROHIT"}, "DM with Rohit", "dm_user: 'Rohit'"},
		// Group DM: no name to show, retry by ID
		{database.PendingSlackMessage{ChannelID: "G0GROUPDM1", ChannelLabel: "G0GROUPDM1"}, "G0GROUPDM1", "channel: 'G0GROUPDM1'"},
	}
	for _, c := range cases {
		dest, retry := describeSendDestination(c.row, channels, users)
		if dest != c.wantDest || retry != c.wantRe {
			t.Errorf("got (%q, %q), want (%q, %q)", dest, retry, c.wantDest, c.wantRe)
		}
	}
}

func TestPreviewText(t *testing.T) {
	if got := previewText("📊  Weekly\nSummary", 80); got != "📊 Weekly Summary" {
		t.Errorf("got %q", got)
	}
	if got := previewText("abcdefghij", 4); got != "abcd…" {
		t.Errorf("got %q", got)
	}
}
