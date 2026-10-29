package youtrack

import "testing"

func TestWithVelocityFooter(t *testing.T) {
	tail := "\n\n&nbsp;\n\n" + VelocityFooter
	cases := []struct{ in, want string }{
		{"", VelocityFooter},
		{"Steps to reproduce", "Steps to reproduce" + tail},
		{"Body" + tail, "Body" + tail},
		{"Body\n\n_created by velocity_\n", "Body" + tail},
		{"Body\n\nCreated by Velocity 🤖", "Body" + tail}, // older plain footer is upgraded
		{"Body\n\n# Created by Velocity", "Body" + tail},
		{"Body" + tail + "\n\n![](shot.png)", "Body\n\n![](shot.png)" + tail},
	}
	for _, c := range cases {
		if got := WithVelocityFooter(c.in); got != c.want {
			t.Errorf("WithVelocityFooter(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	if HasVelocityFooter("Velocity created this") {
		t.Error("loose mention should not count as the footer")
	}
}
