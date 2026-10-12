package kb

import (
	"strings"
	"unicode"
)

// Walls of text: a paragraph longer than WindowFromChars (some PDFs are one
// paragraph for pages) has no structure to follow, so it is cut into
// smaller sentence windows that overlap by one sentence. Smaller than the
// normal chunk target because a big window mixes several people or topics
// and the search then can't tell which one a match belongs to. A window
// also ends where a sentence starts with a new name ("Sandeep Kaur, known
// as Harman, ..."), so profile-style text splits per person even with no
// paragraph breaks.
const (
	WindowFromChars    = 1500 // paragraphs longer than this are windowed (about a third of a page)
	WindowTargetChars  = 900
	WindowMaxChars     = 1300
	WindowMinChars     = 250 // a new name only starts a new window after this much text
	WindowOverlapChars = 300 // longest sentence carried into the next window
)

func windowText(heading, text string) []Chunk {
	marked := sentenceEndRe.ReplaceAllString(text, "$1\x00")
	var sentences []string
	for _, s := range strings.Split(marked, "\x00") {
		s = strings.TrimSpace(s)
		for len(s) > WindowMaxChars { // a giant "sentence" (no punctuation): cut at a space
			cut := strings.LastIndex(s[:WindowTargetChars], " ")
			if cut <= 0 {
				cut = WindowTargetChars
			}
			sentences = append(sentences, strings.TrimSpace(s[:cut]))
			s = strings.TrimSpace(s[cut:])
		}
		if s != "" {
			sentences = append(sentences, s)
		}
	}

	var out []Chunk
	var cur []string
	curLen := 0
	emit := func(carry bool) {
		if len(cur) == 0 {
			return
		}
		out = append(out, Chunk{Heading: heading, Content: strings.Join(cur, " "), Windowed: true})
		last := cur[len(cur)-1]
		cur, curLen = nil, 0
		if carry && len(last) <= WindowOverlapChars {
			cur, curLen = []string{last}, len(last)
		}
	}
	fresh := 0 // sentences in cur that are not the carried overlap
	for _, s := range sentences {
		switch {
		case fresh > 0 && curLen >= WindowMinChars && startsNewSubject(s, strings.Join(cur, " ")):
			// New person or topic: don't carry the previous one's last sentence over.
			emit(false)
			fresh = 0
		case fresh > 0 && curLen+1+len(s) > WindowTargetChars:
			emit(true)
			fresh = 0
		}
		cur = append(cur, s)
		curLen += len(s) + 1
		fresh++
	}
	if fresh > 0 {
		emit(false)
	}
	return out
}

// sentenceStarters are capitalised words that open a sentence without
// naming a new subject.
var sentenceStarters = map[string]bool{}

func init() {
	for _, w := range strings.Fields(`however meanwhile later earlier today yesterday tomorrow overall finally
		additionally also during after before since while although though because once when then next
		first second third last another every each both most many several some one two three
		monday tuesday wednesday thursday friday saturday sunday january february march april may june
		july august september october november december in on at by for with from as to of despite
		unfortunately fortunately apart besides furthermore moreover instead otherwise still yet
		similarly likewise thus therefore hence according around nearly almost`) {
		sentenceStarters[w] = true
	}
}

// continuingStarters open a sentence about the subject already in play.
var continuingStarters = map[string]bool{
	"he": true, "she": true, "they": true, "his": true, "her": true, "their": true,
	"it": true, "its": true, "this": true, "that": true, "these": true, "those": true,
}

// startsNewSubject reports whether a sentence brings in a name the current
// window has not mentioned: it opens with one ("Sandeep Kaur, known as
// Harman, ...") or introduces a full name anywhere ("The mobile side was
// handled by Tarun Sekhon"). Sentences opening with he, she or they carry
// on with the current subject, so a product named mid-profile ("He owns
// the Play Store checklist") doesn't split it.
func startsNewSubject(sentence, window string) bool {
	fields := strings.Fields(sentence)
	if len(fields) == 0 {
		return false
	}
	lowWindow := strings.ToLower(window)
	first := strings.ToLower(letters(fields[0]))
	if continuingStarters[first] {
		return false
	}
	if isNameWord(fields[0]) && !stopwords[first] && !sentenceStarters[first] {
		return !strings.Contains(lowWindow, first)
	}
	for i := 1; i+1 < len(fields); i++ {
		// "Tarun Sekhon": two Title-case words, the first not after a full stop
		if isNameWord(fields[i]) && isNameWord(fields[i+1]) && !strings.HasSuffix(fields[i-1], ".") {
			w := strings.ToLower(letters(fields[i]))
			if !stopwords[w] && !sentenceStarters[w] && !strings.Contains(lowWindow, w) {
				return true
			}
		}
	}
	return false
}

// isNameWord: Title-case ("Tarun", "Sekhon,"), not an acronym or number.
func isNameWord(f string) bool {
	rs := []rune(letters(f))
	return len(rs) >= 2 && unicode.IsUpper(rs[0]) && unicode.IsLower(rs[1])
}

func letters(f string) string {
	return strings.TrimFunc(f, func(r rune) bool { return !unicode.IsLetter(r) })
}
