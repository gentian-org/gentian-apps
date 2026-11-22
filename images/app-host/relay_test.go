// SPDX-License-Identifier: MIT

package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
)

// davHome is a WebDAV home in memory that keeps each person's files under
// files/<name>/, as Nextcloud does.
type davHome struct {
	mu      sync.Mutex
	entries map[string]string // path -> content; a path ending in / is a folder
	seen    []string
}

const davRoot = "/remote.php/dav/files/ada/"

func (h *davHome) ServeHTTP(rw http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seen = append(h.seen, r.Method+" "+r.URL.Path)
	if r.Header.Get("Authorization") != "Bearer "+homeToken {
		rw.WriteHeader(http.StatusUnauthorized)
		return
	}
	p := r.URL.Path
	parent := p[:strings.LastIndex(strings.TrimSuffix(p, "/"), "/")+1]
	multi := func(paths []string) {
		var b strings.Builder
		b.WriteString(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">`)
		for _, q := range paths {
			props := `<d:resourcetype><d:collection/></d:resourcetype>`
			if !strings.HasSuffix(q, "/") {
				props = `<d:resourcetype/><d:getetag>"` + h.entries[q] + `"</d:getetag>`
			}
			// Absolute addresses, escaped, as some homes give them.
			b.WriteString(`<d:response><d:href>http://home.example` + strings.ReplaceAll(q, " ", "%20") +
				`</d:href><d:propstat><d:prop>` + props + `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
		}
		b.WriteString(`</d:multistatus>`)
		rw.WriteHeader(http.StatusMultiStatus)
		_, _ = io.WriteString(rw, b.String())
	}
	switch r.Method {
	case "PROPFIND":
		if p == "/remote.php/dav/" {
			rw.WriteHeader(http.StatusMultiStatus)
			_, _ = io.WriteString(rw, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/remote.php/dav/principals/users/ada/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`)
			return
		}
		if _, ok := h.entries[p]; !ok {
			rw.WriteHeader(http.StatusNotFound)
			return
		}
		list := []string{p}
		if strings.HasSuffix(p, "/") && r.Header.Get("Depth") == "1" {
			for q := range h.entries {
				if q != p && strings.HasPrefix(q, p) && !strings.Contains(strings.TrimSuffix(q[len(p):], "/"), "/") {
					list = append(list, q)
				}
			}
		}
		sort.Strings(list)
		multi(list)
	case "MKCOL":
		if _, ok := h.entries[p]; ok {
			rw.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if _, ok := h.entries[parent]; !ok {
			rw.WriteHeader(http.StatusConflict)
			return
		}
		h.entries[p] = ""
		rw.WriteHeader(http.StatusCreated)
	case "GET":
		c, ok := h.entries[p]
		if !ok || strings.HasSuffix(p, "/") {
			rw.WriteHeader(http.StatusNotFound)
			return
		}
		rw.Header().Set("ETag", `"`+c+`"`)
		rw.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(rw, c)
	case "PUT":
		if _, ok := h.entries[parent]; !ok {
			rw.WriteHeader(http.StatusConflict)
			return
		}
		cur, exists := h.entries[p]
		if m := r.Header.Get("If-Match"); m != "" && (!exists || m != `"`+cur+`"`) {
			rw.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		if r.Header.Get("If-None-Match") == "*" && exists {
			rw.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		body, _ := io.ReadAll(r.Body)
		h.entries[p] = string(body)
		rw.Header().Set("ETag", `"`+string(body)+`"`)
		rw.WriteHeader(http.StatusCreated)
	case "DELETE":
		if _, ok := h.entries[p]; !ok {
			rw.WriteHeader(http.StatusNotFound)
			return
		}
		delete(h.entries, p)
		rw.WriteHeader(http.StatusNoContent)
	default:
		rw.WriteHeader(http.StatusMethodNotAllowed)
	}
}

type relayWorld struct {
	t       *testing.T
	home    *davHome
	handler http.Handler
}

func newRelayWorld(t *testing.T, withHome bool) *relayWorld {
	t.Helper()
	base := newWorld(t) // the realm and the vouching client
	dav := &davHome{entries: map[string]string{davRoot: "", davRoot + "private.txt": "secret"}}
	srv := httptest.NewServer(dav)
	t.Cleanup(srv.Close)

	site := t.TempDir()
	_ = os.WriteFile(filepath.Join(site, "index.html"), []byte("<html>sp</html>"), 0o600)
	_ = os.WriteFile(filepath.Join(site, "main-ABC.js"), []byte("js"), 0o600)
	tmpl := filepath.Join(t.TempDir(), "settings.json")
	_ = os.WriteFile(tmpl, []byte(`{"webDav":{"baseUrl":"{{origin}}/webdav/","userName":"{{name}}","syncFolderPath":"/","folder":"{{folder}}"}}`), 0o600)

	cfg := base.cfg
	cfg.site = site
	cfg.mode = "relay"
	cfg.davFolder = "Super Productivity"
	cfg.settingsPath = "/assets/sync-config-default-override.json"
	cfg.settingsTemplate = tmpl
	cfg.home = srv.URL + "/remote.php/dav/"
	if !withHome {
		cfg.home = ""
	}
	return &relayWorld{t: t, home: dav, handler: newServer(cfg)}
}

// call is a request of the app's script as the edge passes it on: the
// person's token in place of what the app sent, from the same origin.
func (w *relayWorld) call(method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	w.t.Helper()
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer edge-token-of-ada")
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	r.Header.Set("Sec-Fetch-Mode", "cors")
	for k, v := range headers {
		if v == "" {
			r.Header.Del(k)
		} else {
			r.Header.Set(k, v)
		}
	}
	rec := httptest.NewRecorder()
	w.handler.ServeHTTP(rec, r)
	return rec
}

func TestRelayMakesTheFolderAndKeepsTheAppInIt(t *testing.T) {
	w := newRelayWorld(t, true)

	// The app's first look: its folder, made on the way.
	rec := w.call("PROPFIND", "/webdav/", "", map[string]string{"Depth": "1"})
	if rec.Code != http.StatusMultiStatus {
		t.Fatalf("PROPFIND: %d %s", rec.Code, rec.Body)
	}
	if _, ok := w.home.entries[davRoot+"Super Productivity/"]; !ok {
		t.Fatalf("folder not made; home saw %v", w.home.seen)
	}
	// The listing names the relay's addresses, never the home's.
	if body := rec.Body.String(); !strings.Contains(body, "<d:href>/webdav/</d:href>") || strings.Contains(body, "remote.php") {
		t.Fatalf("listing: %s", body)
	}

	// A file written only where none is, then replaced only as read.
	rec = w.call("PUT", "/webdav/sync-data.json", "v1", map[string]string{"If-None-Match": "*", "Content-Type": "application/json"})
	if rec.Code != http.StatusCreated || rec.Header().Get("ETag") != `"v1"` {
		t.Fatalf("PUT new: %d %v", rec.Code, rec.Header())
	}
	if rec = w.call("PUT", "/webdav/sync-data.json", "v2", map[string]string{"If-None-Match": "*"}); rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("PUT over an existing file with If-None-Match: %d", rec.Code)
	}
	if rec = w.call("PUT", "/webdav/sync-data.json", "v2", map[string]string{"If-Match": `"stale"`}); rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("PUT with a stale If-Match: %d", rec.Code)
	}
	if rec = w.call("PUT", "/webdav/sync-data.json", "v2", map[string]string{"If-Match": `"v1"`}); rec.Code != http.StatusCreated {
		t.Fatalf("PUT with the current If-Match: %d", rec.Code)
	}
	rec = w.call("GET", "/webdav/sync-data.json", "", nil)
	if rec.Code != http.StatusOK || rec.Body.String() != "v2" || rec.Header().Get("ETag") != `"v2"` {
		t.Fatalf("GET: %d %q %v", rec.Code, rec.Body, rec.Header())
	}
	// Bytes, and nothing a browser renders as a page of this address.
	if rec.Header().Get("Content-Type") != "application/octet-stream" || rec.Header().Get("Content-Security-Policy") != "sandbox" {
		t.Fatalf("GET headers: %v", rec.Header())
	}

	// A file's own listing, by its relay address.
	rec = w.call("PROPFIND", "/webdav/sync-data.json", "", map[string]string{"Depth": "0"})
	if !strings.Contains(rec.Body.String(), "<d:href>/webdav/sync-data.json</d:href>") {
		t.Fatalf("file listing: %s", rec.Body)
	}
	if rec = w.call("DELETE", "/webdav/sync-data.json", "", nil); rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE: %d", rec.Code)
	}

	// Nothing beside the folder: no step upwards reaches the person's
	// other files.
	for _, target := range []string{"/webdav/../private.txt", "/webdav/%2e%2e/private.txt", "/webdav/a/../../private.txt"} {
		r := httptest.NewRequest("GET", "/", nil)
		r.URL.Path = strings.ReplaceAll(target, "%2e", ".")
		r.Header.Set("Authorization", "Bearer edge-token-of-ada")
		r.Header.Set("Sec-Fetch-Site", "same-origin")
		rr := httptest.NewRecorder()
		w.handler.ServeHTTP(rr, r)
		if rr.Code == http.StatusOK || strings.Contains(rr.Body.String(), "secret") {
			t.Fatalf("%s reached outside the folder: %d %s", target, rr.Code, rr.Body)
		}
	}
	for _, seen := range w.home.seen {
		if strings.HasSuffix(seen, "/private.txt") {
			t.Fatalf("the home was asked for %s", seen)
		}
	}
}

func TestRelayRefusesWhatIsNotTheAppsOwnCall(t *testing.T) {
	w := newRelayWorld(t, true)
	cases := map[string]map[string]string{
		"a navigation":            {"Sec-Fetch-Mode": "navigate"},
		"another site":            {"Sec-Fetch-Site": "cross-site"},
		"no token from the edge":  {"Authorization": ""},
		"a token the realm keeps": {"Authorization": "Bearer someone-else"},
	}
	for name, headers := range cases {
		rec := w.call("GET", "/webdav/sync-data.json", "", headers)
		if rec.Code < 400 {
			t.Errorf("%s: %d", name, rec.Code)
		}
	}
	if rec := w.call("PROPPATCH", "/webdav/x", "", nil); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("PROPPATCH: %d", rec.Code)
	}
}

func TestRelayServesTheAppAndItsSettings(t *testing.T) {
	w := newRelayWorld(t, true)
	// The app at the root; one of its own routes gets the entry page.
	for _, p := range []string{"/", "/tag/TODAY/tasks"} {
		rec := w.call("GET", p, "", nil)
		if rec.Code != http.StatusOK || rec.Body.String() != "<html>sp</html>" {
			t.Fatalf("%s: %d %q", p, rec.Code, rec.Body)
		}
	}
	if rec := w.call("GET", "/main-ABC.js", "", nil); rec.Body.String() != "js" {
		t.Fatalf("asset: %q", rec.Body)
	}

	// Its settings name this address's relay and the person.
	rec := w.call("GET", "/assets/sync-config-default-override.json", "", map[string]string{
		"Host": "", "X-Forwarded-Proto": "https", "x-gentian-email": `ada@example.org`,
	})
	want := `{"webDav":{"baseUrl":"https://example.com/webdav/","userName":"ada@example.org","syncFolderPath":"/","folder":"Super Productivity"}}`
	if rec.Code != http.StatusOK || rec.Body.String() != want {
		t.Fatalf("settings: %d %s", rec.Code, rec.Body)
	}

	// Without a home there are none, and the relay says why.
	w = newRelayWorld(t, false)
	if rec := w.call("GET", "/assets/sync-config-default-override.json", "", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("settings without a home: %d", rec.Code)
	}
	if rec := w.call("PROPFIND", "/webdav/", "", nil); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("relay without a home: %d", rec.Code)
	}
}

func TestRewriteHrefs(t *testing.T) {
	in := `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/files/ada/Super%20Productivity/</d:href></d:response>` +
		`<d:response><D:href>https://h/dav/files/ada/Super%20Productivity/a%20b.json</D:href></d:response>` +
		`<d:response><href>/dav/files/ada/other.txt</href></d:response></d:multistatus>`
	out := string(rewriteHrefs([]byte(in), "/dav/files/ada/Super Productivity/"))
	for _, want := range []string{"<d:href>/webdav/</d:href>", "<D:href>/webdav/a%20b.json</D:href>", "<href>/webdav/</href>"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %s in %s", want, out)
		}
	}
}
