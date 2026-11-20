// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// world is a realm and a home standing in for the tenant's, and the server
// under test told about both as a pod is.
type world struct {
	t         *testing.T
	handler   http.Handler
	vouching  string
	mu        sync.Mutex
	exchanges []url.Values
	files     map[string]string // path below the person's root -> content
	seen      []string          // "METHOD path" of every call to the home
}

const homeToken = "home-token-of-ada"

func newWorld(t *testing.T) *world {
	t.Helper()
	w := &world{t: t, files: map[string]string{"/Letters/hello.docx": "v1", "/notes.txt": "n", "/photo.png": "p"}}

	realm := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		w.mu.Lock()
		w.exchanges = append(w.exchanges, r.PostForm)
		w.mu.Unlock()
		if r.PostForm.Get("subject_token") != "edge-token-of-ada" {
			rw.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(rw, `{"error":"invalid_token","error_description":"secret realm detail"}`)
			return
		}
		_, _ = io.WriteString(rw, `{"access_token":"`+homeToken+`","expires_in":300}`)
	}))
	t.Cleanup(realm.Close)

	home := httptest.NewServer(http.HandlerFunc(w.home))
	t.Cleanup(home.Close)

	w.vouching = t.TempDir()
	for k, v := range map[string]string{
		"VOUCHING_CLIENT_ID":       "vouch-wordcraft-ce",
		"VOUCHING_CLIENT_SECRET":   "s3cret",
		"VOUCHING_TOKEN_URL":       realm.URL + "/token",
		"VOUCHING_HOME_FILE_STORE": "home-files",
	} {
		if err := os.WriteFile(filepath.Join(w.vouching, k), []byte(v), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	site := t.TempDir()
	_ = os.WriteFile(filepath.Join(site, "index.html"), []byte("<html>app</html>"), 0o600)
	_ = os.WriteFile(filepath.Join(site, "app.wasm"), []byte("wasm"), 0o600)
	_ = os.WriteFile(filepath.Join(site, "app.wasm.gz"), []byte("gzipped"), 0o600)

	w.handler = newServer(config{
		app: "wordcraft", title: "WordCraft", site: site,
		home: home.URL + "/remote.php/dav/", vouching: w.vouching,
		extensions: []string{".docx", ".txt"}, maxBytes: 1 << 20,
	})
	return w
}

// home answers as a home that keeps each person's files under files/<name>/.
func (w *world) home(rw http.ResponseWriter, r *http.Request) {
	w.mu.Lock()
	w.seen = append(w.seen, r.Method+" "+r.URL.Path)
	w.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+homeToken {
		rw.WriteHeader(http.StatusUnauthorized)
		return
	}
	const root = "/remote.php/dav/files/ada"
	multi := func(body string) {
		rw.Header().Set("Content-Type", "application/xml")
		rw.WriteHeader(http.StatusMultiStatus)
		_, _ = io.WriteString(rw, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">`+body+`</d:multistatus>`)
	}
	item := func(href, props string) string {
		return `<d:response><d:href>` + href + `</d:href><d:propstat><d:prop>` + props + `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
	}
	rel := strings.TrimPrefix(r.URL.Path, root)
	switch {
	case r.Method == "PROPFIND" && r.URL.Path == "/remote.php/dav/":
		multi(item("/remote.php/dav/", `<d:current-user-principal><d:href>/remote.php/dav/principals/users/ada/</d:href></d:current-user-principal>`))
	case r.Method == "PROPFIND" && r.URL.Path == root+"/" && r.Header.Get("Depth") == "0":
		multi(item(root+"/", `<d:resourcetype><d:collection/></d:resourcetype>`))
	case r.Method == "PROPFIND" && r.URL.Path == root+"/":
		multi(item(root+"/", `<d:resourcetype><d:collection/></d:resourcetype>`) +
			item(root+"/Letters/", `<d:resourcetype><d:collection/></d:resourcetype>`) +
			item(root+"/notes.txt", `<d:resourcetype/><d:getcontentlength>1</d:getcontentlength><d:getetag>"e-notes"</d:getetag>`) +
			item(root+"/photo.png", `<d:resourcetype/><d:getcontentlength>1</d:getcontentlength>`) +
			item(root+"/.hidden.txt", `<d:resourcetype/>`))
	case r.Method == http.MethodGet:
		content, ok := w.files[rel]
		if !ok {
			rw.WriteHeader(http.StatusNotFound)
			return
		}
		rw.Header().Set("ETag", `"`+content+`"`)
		rw.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(rw, content)
	case r.Method == http.MethodPut:
		current, exists := w.files[rel]
		if m := r.Header.Get("If-Match"); m != "" && m != `"`+current+`"` {
			rw.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		if r.Header.Get("If-None-Match") == "*" && exists {
			rw.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		body, _ := io.ReadAll(r.Body)
		w.files[rel] = string(body)
		rw.Header().Set("ETag", `"`+string(body)+`"`)
		rw.WriteHeader(http.StatusNoContent)
	default:
		rw.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// call is a request as the edge passes one on: the person's token in the
// header, and the page's own mark unless left out.
func (w *world) call(method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	w.t.Helper()
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer edge-token-of-ada")
	r.Header.Set("X-Craft-Host", "1")
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

func TestListsThePersonsFilesTheAppOpens(t *testing.T) {
	w := newWorld(t)
	rec := w.call("GET", "/files/list?path=/", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var got struct {
		Entries []entry `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	// The folder first, then the one file the app opens: no picture, no
	// hidden file, not the folder itself.
	if len(got.Entries) != 2 || got.Entries[0].Name != "Letters" || !got.Entries[0].Folder ||
		got.Entries[1].Name != "notes.txt" || got.Entries[1].ETag != `"e-notes"` {
		t.Fatalf("entries = %+v", got.Entries)
	}

	// The realm was asked once, as the app's client, for the home's scope
	// and with the token the edge handed over.
	if len(w.exchanges) != 1 {
		t.Fatalf("%d exchanges", len(w.exchanges))
	}
	f := w.exchanges[0]
	for k, want := range map[string]string{
		"grant_type": "urn:ietf:params:oauth:grant-type:token-exchange", "client_id": "vouch-wordcraft-ce",
		"client_secret": "s3cret", "subject_token": "edge-token-of-ada", "scope": "home-files",
		"subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
	} {
		if f.Get(k) != want {
			t.Errorf("%s = %q, want %q", k, f.Get(k), want)
		}
	}
	// A second call of the same session asks the realm nothing.
	w.call("GET", "/files/list?path=/", "", nil)
	if len(w.exchanges) != 1 {
		t.Fatalf("%d exchanges after a second call", len(w.exchanges))
	}
}

func TestReadsAFileAsBytesNoBrowserRenders(t *testing.T) {
	w := newWorld(t)
	rec := w.call("GET", "/files/content?path=/Letters/hello.docx", "", nil)
	if rec.Code != http.StatusOK || rec.Body.String() != "v1" || rec.Header().Get("ETag") != `"v1"` {
		t.Fatalf("status %d etag %q body %q", rec.Code, rec.Header().Get("ETag"), rec.Body)
	}
	h := rec.Header()
	if h.Get("Content-Type") != "application/octet-stream" || h.Get("Content-Security-Policy") != "sandbox" ||
		h.Get("X-Content-Type-Options") != "nosniff" || h.Get("Content-Disposition") != "attachment" {
		t.Fatalf("headers %v", h)
	}
	if rec := w.call("GET", "/files/content?path=/missing.docx", "", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("a missing file: %d", rec.Code)
	}
}

func TestWritesOnlyWhatThePageSaw(t *testing.T) {
	w := newWorld(t)
	const target = "/files/content?path=/Letters/hello.docx"
	// The version read: replaced.
	rec := w.call("PUT", target, "v2", map[string]string{"If-Match": `"v1"`})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `\"v2\"`) {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	// A version that is gone: refused, and the file stays.
	if rec := w.call("PUT", target, "v3", map[string]string{"If-Match": `"v1"`}); rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("a stale save: %d", rec.Code)
	}
	if w.files["/Letters/hello.docx"] != "v2" {
		t.Fatalf("the file holds %q", w.files["/Letters/hello.docx"])
	}
	// A new name where a file is: refused. Where none is: written.
	if rec := w.call("PUT", target, "x", map[string]string{"If-None-Match": "*"}); rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("a save over an existing file: %d", rec.Code)
	}
	if rec := w.call("PUT", "/files/content?path=/Letters/new.docx", "new", map[string]string{"If-None-Match": "*"}); rec.Code != http.StatusOK {
		t.Fatalf("a new file: %d %s", rec.Code, rec.Body)
	}
	// Too large: refused before the home is asked.
	if rec := w.call("PUT", "/files/content?path=/big.docx", strings.Repeat("x", 2<<20), nil); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("a file over the limit: %d", rec.Code)
	}
}

func TestRefusesWhatIsNotThePagesOwnCall(t *testing.T) {
	w := newWorld(t)
	for name, headers := range map[string]map[string]string{
		"a navigation or another site's request, without the page's mark": {"X-Craft-Host": ""},
		"a request the browser says is another site's":                    {"Sec-Fetch-Site": "cross-site"},
	} {
		if rec := w.call("GET", "/files/content?path=/notes.txt", "", headers); rec.Code != http.StatusForbidden {
			t.Errorf("%s: %d", name, rec.Code)
		}
	}
	if rec := w.call("GET", "/files/list?path=/", "", map[string]string{"Authorization": ""}); rec.Code != http.StatusUnauthorized {
		t.Errorf("no token: %d", rec.Code)
	}
	// A token the realm does not exchange: refused, without the realm's words.
	rec := w.call("GET", "/files/list?path=/", "", map[string]string{"Authorization": "Bearer somebody-else"})
	if rec.Code != http.StatusForbidden || strings.Contains(rec.Body.String(), "secret realm detail") {
		t.Errorf("a token the realm refuses: %d %s", rec.Code, rec.Body)
	}
	for _, p := range []string{"/../../principals", "/a/../../b", "relative", "/a/./b", `/a\b`} {
		if rec := w.call("GET", "/files/content?path="+url.QueryEscape(p), "", nil); rec.Code != http.StatusBadRequest {
			t.Errorf("path %q: %d", p, rec.Code)
		}
	}
	// The home was asked where the person's files are, and for no file.
	for _, call := range w.seen {
		if !strings.HasPrefix(call, "PROPFIND ") {
			t.Errorf("the home was asked: %s", call)
		}
	}
}

func TestWithoutAHomeTheAppIsServedAsItIs(t *testing.T) {
	w := newWorld(t)
	page := func() *httptest.ResponseRecorder {
		return w.call("GET", "/", "", map[string]string{"X-Craft-Host": ""})
	}
	if rec := page(); rec.Code != http.StatusOK || !strings.Contains(rec.Header().Get("Content-Security-Policy"), "frame-src 'self'") {
		t.Fatalf("the page with a home: %d", rec.Code)
	}
	// The grant is taken back: the platform removes the scope's entry.
	if err := os.Remove(filepath.Join(w.vouching, "VOUCHING_HOME_FILE_STORE")); err != nil {
		t.Fatal(err)
	}
	if rec := page(); rec.Code != http.StatusFound || rec.Header().Get("Location") != "/app/" {
		t.Fatalf("the page without a home: %d %s", rec.Code, rec.Header().Get("Location"))
	}
	if rec := w.call("GET", "/files/list?path=/", "", nil); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("a file call without a home: %d", rec.Code)
	}
}

func TestServesTheAppsBuild(t *testing.T) {
	w := newWorld(t)
	get := func(target, encoding string) *httptest.ResponseRecorder {
		return w.call("GET", target, "", map[string]string{"Accept-Encoding": encoding})
	}
	if rec := get("/app/", ""); rec.Code != http.StatusOK || rec.Body.String() != "<html>app</html>" || rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("the entry page: %d %q", rec.Code, rec.Body)
	}
	rec := get("/app/app.wasm", "gzip, br")
	if rec.Body.String() != "gzipped" || rec.Header().Get("Content-Encoding") != "gzip" || rec.Header().Get("Content-Type") != "application/wasm" {
		t.Fatalf("the compressed build: %q %v", rec.Body, rec.Header())
	}
	if rec := get("/app/app.wasm", ""); rec.Body.String() != "wasm" || rec.Header().Get("Content-Encoding") != "" {
		t.Fatalf("the plain build: %q", rec.Body)
	}
	for _, target := range []string{"/app/missing.js", "/app/../main.go", "/app/%2e%2e/%2e%2e/etc/passwd"} {
		// Not found, or sent to the cleaned address: never a file.
		if rec := get(target, ""); rec.Code == http.StatusOK {
			t.Errorf("%s: %d %q", target, rec.Code, rec.Body)
		}
	}
	if rec := get("/healthz", ""); rec.Code != http.StatusOK {
		t.Fatalf("healthz: %d", rec.Code)
	}
}
