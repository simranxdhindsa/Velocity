package handlers

import (
	"embed"
	"io/fs"
	"net/http"
)

// Images for the in-app how-to guides (e.g. /demo/epic-swimlanes). They show
// real board content, so they are built into the binary and served only
// behind AuthMiddleware, never from the public static folder.
//
//go:embed demo_media
var demoMedia embed.FS

// DemoMedia serves /api/demo-media/<guide>/<file> from the embedded files.
func DemoMedia() http.Handler {
	sub, _ := fs.Sub(demoMedia, "demo_media") // cannot fail: the directory is embedded above
	files := http.StripPrefix("/api/demo-media/", http.FileServer(http.FS(sub)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, max-age=3600") // never kept by shared caches
		files.ServeHTTP(w, r)
	})
}
