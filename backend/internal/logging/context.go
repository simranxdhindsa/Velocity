package logging

import (
	"context"
	"sort"
	"sync"
	"time"
)

type ctxKey int

const (
	infoKey ctxKey = iota
	jobKey
	noTraceKey
)

// info is the mutable, request-scoped record the middleware stores in the
// context. Everything that learns something about the request (auth, routing,
// outbound calls, DB queries) writes into it, and the access line reads it.
type info struct {
	mu       sync.Mutex
	id       string
	route    string
	userID   string
	fields   map[string]any
	outCount int
	outDur   time.Duration
	dbCount  int
	dbDur    time.Duration
}

type jobInfo struct {
	name  string
	runID string
}

func getInfo(ctx context.Context) *info {
	if ctx == nil {
		return nil
	}
	in, _ := ctx.Value(infoKey).(*info)
	return in
}

func getJob(ctx context.Context) *jobInfo {
	if ctx == nil {
		return nil
	}
	j, _ := ctx.Value(jobKey).(*jobInfo)
	return j
}

// RequestID returns the request id carried by ctx, or "".
func RequestID(ctx context.Context) string {
	if in := getInfo(ctx); in != nil {
		in.mu.Lock()
		defer in.mu.Unlock()
		return in.id
	}
	return ""
}

// SetUser records the authenticated user on the request. No-op without a request.
func SetUser(ctx context.Context, userID string) {
	if in := getInfo(ctx); in != nil {
		in.mu.Lock()
		in.userID = userID
		in.mu.Unlock()
	}
}

// SetRoute records the matched route template on the request.
func SetRoute(ctx context.Context, tmpl string) {
	if in := getInfo(ctx); in != nil {
		in.mu.Lock()
		in.route = tmpl
		in.mu.Unlock()
	}
}

// AddField attaches an extra attribute to the request's access line.
func AddField(ctx context.Context, key string, val any) {
	if in := getInfo(ctx); in != nil {
		in.mu.Lock()
		if in.fields == nil {
			in.fields = map[string]any{}
		}
		in.fields[key] = val
		in.mu.Unlock()
	}
}

// Detach returns a context that is not cancelled with ctx but keeps the request
// id and user id (and job), so work that outlives the request still logs them.
func Detach(ctx context.Context) context.Context {
	out := context.Background()
	if j := getJob(ctx); j != nil {
		out = context.WithValue(out, jobKey, j)
	}
	if in := getInfo(ctx); in != nil {
		in.mu.Lock()
		cp := &info{id: in.id, userID: in.userID, route: in.route}
		in.mu.Unlock()
		out = context.WithValue(out, infoKey, cp)
	}
	return out
}

// WithJob marks ctx as belonging to a background job run.
func WithJob(ctx context.Context, name, runID string) context.Context {
	return context.WithValue(ctx, jobKey, &jobInfo{name: name, runID: runID})
}

// NoTrace marks ctx so DB queries run with it are not traced or logged.
func NoTrace(ctx context.Context) context.Context {
	return context.WithValue(ctx, noTraceKey, true)
}

func isNoTrace(ctx context.Context) bool {
	if ctx == nil {
		return false
	}
	v, _ := ctx.Value(noTraceKey).(bool)
	return v
}

func addOutbound(ctx context.Context, d time.Duration) {
	if in := getInfo(ctx); in != nil {
		in.mu.Lock()
		in.outCount++
		in.outDur += d
		in.mu.Unlock()
	}
}

func addDB(ctx context.Context, d time.Duration) {
	if in := getInfo(ctx); in != nil {
		in.mu.Lock()
		in.dbCount++
		in.dbDur += d
		in.mu.Unlock()
	}
}

type infoSnapshot struct {
	id, route, userID string
	fieldKeys         []string
	fields            map[string]any
	outCount, dbCount int
	outDur, dbDur     time.Duration
}

func (in *info) snapshot() infoSnapshot {
	in.mu.Lock()
	defer in.mu.Unlock()
	s := infoSnapshot{id: in.id, route: in.route, userID: in.userID,
		outCount: in.outCount, dbCount: in.dbCount, outDur: in.outDur, dbDur: in.dbDur,
		fields: make(map[string]any, len(in.fields))}
	for k, v := range in.fields {
		s.fields[k] = v
		s.fieldKeys = append(s.fieldKeys, k)
	}
	sort.Strings(s.fieldKeys)
	return s
}
