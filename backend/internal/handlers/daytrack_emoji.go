package handlers

import "strings"

// defaultCategoryEmoji is the fixed icon shown for every built-in Day Track
// category (the ones every user gets without adding anything custom).
var defaultCategoryEmoji = map[string]string{
	"development":        "🐛",
	"testing":            "🧪",
	"meetings":           "👥",
	"breaks":             "☕",
	"review":             "🔍",
	"research":           "🔬",
	"sign in":            "🟢",
	"sign off":           "🔴",
	"project management": "📌",
	"tickets created":    "📆",
	"tickets tested":     "🧪",
	"in progress":        "🔄",
}

// allowedCustomCategoryEmoji is the curated allow-list a custom category's icon
// must come from. Using an allow-list (rather than trying to blocklist offensive
// unicode) is what actually guarantees nothing inappropriate can be saved —
// only neutral objects/symbols are offered, no faces or hand gestures at all.
var allowedCustomCategoryEmoji = map[string]bool{
	"💻": true, "🐛": true, "🧪": true, "🔍": true, "🔬": true, "📋": true, "📌": true, "📆": true, "📅": true, "👥": true,
	"☕": true, "🔴": true, "🟢": true, "🔵": true, "🟡": true, "🟣": true, "🟠": true, "⚪": true, "⚫": true,
	"📝": true, "📊": true, "📈": true, "📉": true, "🎯": true, "🚀": true, "🛠️": true, "⚙️": true, "📞": true, "📧": true,
	"💬": true, "🗓️": true, "✅": true, "❌": true, "⚠️": true, "🔥": true, "💡": true, "📦": true, "🔗": true,
	"🖥️": true, "📱": true, "🎨": true, "🔐": true, "🚨": true, "🧩": true, "🧵": true, "🔧": true, "🐞": true,
	"📚": true, "🎓": true, "🧠": true, "🕐": true, "⏰": true, "🗂️": true, "📁": true, "🔔": true, "🌐": true, "🧭": true,
	"🛡️": true, "🧰": true, "🚦": true, "📎": true, "🖊️": true, "🗃️": true, "🗄️": true, "🧮": true, "🔋": true, "🔌": true,
	"💾": true, "💿": true, "🖱️": true, "⌨️": true, "🖨️": true, "📡": true, "🛰️": true, "🧱": true, "🏗️": true,
	"🚩": true, "🏁": true, "🎬": true, "🧊": true,
}

// isAllowedCategoryEmoji reports whether icon is on the curated safe list.
// Server-side check so the picker's allow-list can't be bypassed by calling
// the API directly with an arbitrary string.
func isAllowedCategoryEmoji(icon string) bool {
	return allowedCustomCategoryEmoji[icon]
}

// categoryEmoji resolves the icon for a category name: the fixed default map
// first, then the user's custom categories (name -> icon), falling back to a
// generic bullet when neither has one.
func categoryEmoji(name string, custom map[string]string) string {
	key := strings.ToLower(strings.TrimSpace(name))
	if icon, ok := defaultCategoryEmoji[key]; ok {
		return icon
	}
	if icon, ok := custom[key]; ok && icon != "" {
		return icon
	}
	return "▪️"
}
