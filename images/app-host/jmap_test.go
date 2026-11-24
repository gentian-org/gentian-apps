// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// jmapSite is a build like MailCraft's: an entry page whose module script
// starts the app, and its files.
func jmapSite(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"index.html":  "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n<script type=\"module\">import init from './app.js'; await init();</script>\n</head><body></body></html>\n",
		"app.js":      "export default async function init() {}\n",
		"app_bg.wasm": "\x00asm",
		"README.md":   "upstream",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func jmapServer(t *testing.T, session, imapHost string) http.Handler {
	t.Helper()
	return newServer(config{mode: "jmap", app: "mailcraft", title: "MailCraft", site: jmapSite(t),
		jmapSession: session, jmapIMAPHost: imapHost})
}

func get(h http.Handler, target string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, target, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// The entry page carries the host's script first in its head, before the
// module script that starts the app, at its own address and at an app route.
func TestJMAPEntryPageCarriesTheScriptFirst(t *testing.T) {
	h := jmapServer(t, "", "imap.example.net")
	for _, target := range []string{"/", "/index.html", "/mail/inbox"} {
		w := get(h, target, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d", target, w.Code)
		}
		body := w.Body.String()
		script := strings.Index(body, `<script src="/host/jmap.js"></script>`)
		module := strings.Index(body, `<script type="module">`)
		if script < 0 || module < 0 || script > module || script < strings.Index(body, "<head>") {
			t.Fatalf("%s: the host's script is not first in the head:\n%s", target, body)
		}
		if strings.Count(body, "/host/jmap.js") != 1 {
			t.Fatalf("%s: the script is put in more than once", target)
		}
		if got := w.Header().Get("Cross-Origin-Opener-Policy"); got != "same-origin" {
			t.Errorf("%s: Cross-Origin-Opener-Policy = %q", target, got)
		}
		if got := w.Header().Get("Cache-Control"); got != "no-cache" {
			t.Errorf("%s: Cache-Control = %q", target, got)
		}
	}
	// The app's other files are served as they are.
	if w := get(h, "/app.js", nil); w.Code != http.StatusOK || strings.Contains(w.Body.String(), "jmap.js") {
		t.Fatalf("app.js: %d %q", w.Code, w.Body.String())
	}
	if w := get(h, "/app_bg.wasm", nil); w.Header().Get("Content-Type") != "application/wasm" {
		t.Fatalf("wasm served as %q", w.Header().Get("Content-Type"))
	}
}

// The script names the person's account at the session address: the one
// the pod is told, or else the IMAP host's.
func TestJMAPScriptNamesThePersonsAccount(t *testing.T) {
	cases := []struct{ session, imap, want string }{
		{"", "imap.example.net", "https://imap.example.net/jmap/session"},
		{"https://mail.example.net/jmap/session", "imap.example.net", "https://mail.example.net/jmap/session"},
	}
	for _, c := range cases {
		h := jmapServer(t, c.session, c.imap)
		w := get(h, "/host/jmap.js", map[string]string{"x-gentian-email": "ada@example.net", "x-gentian-name": `Ada "</script>" Lovelace`})
		body := w.Body.String()
		if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%d %q", w.Code, w.Header().Get("Cache-Control"))
		}
		start := strings.Index(body, "accounts: [") + len("accounts: [")
		end := strings.Index(body, "],\n};")
		var account map[string]any
		if err := json.Unmarshal([]byte(body[start:end]), &account); err != nil {
			t.Fatalf("account is not JSON: %v\n%s", err, body)
		}
		if account["email"] != "ada@example.net" || account["session"] != c.want || account["bearer"] != false {
			t.Errorf("account = %v, want session %s", account, c.want)
		}
		if strings.Contains(body, "</script>") {
			t.Errorf("a name ends up as markup in the script:\n%s", body)
		}
		// The app asks the person for the password: no secret is named, and
		// nothing of a token is in the script.
		if strings.Contains(body, "secret") || strings.Contains(body, "token") {
			t.Errorf("the script hands over a credential:\n%s", body)
		}
	}
}

// Without a mail server, or without the person's address, the script names
// nothing and the app starts as upstream ships it.
func TestJMAPScriptNamesNothingWithoutAServerOrAnAddress(t *testing.T) {
	for _, c := range []struct {
		imap, email string
	}{
		{"", "ada@example.net"},
		{"imap.example.net/evil?x=", "ada@example.net"},
		{"imap.example.net", ""},
		{"imap.example.net", "not-an-address"},
	} {
		h := jmapServer(t, "", c.imap)
		body := get(h, "/host/jmap.js", map[string]string{"x-gentian-email": c.email}).Body.String()
		if strings.Contains(body, "mailcraftJmap") {
			t.Errorf("imap %q email %q: the script names an account:\n%s", c.imap, c.email, body)
		}
	}
}

// No token is handed out: the address the earlier design used is the app's
// entry page like any app route, and carries no credential.
func TestJMAPHandsOutNoToken(t *testing.T) {
	h := jmapServer(t, "", "imap.example.net")
	w := get(h, "/host/jmap-token", map[string]string{"X-Craft-Host": "1", "Authorization": "Bearer edge-token-of-ada"})
	if strings.Contains(w.Body.String(), "edge-token-of-ada") {
		t.Fatalf("the token was handed out: %s", w.Body.String())
	}
}

// The app is only read.
func TestJMAPAppIsOnlyRead(t *testing.T) {
	h := jmapServer(t, "", "imap.example.net")
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("x"))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /: %d", w.Code)
	}
	_, _ = io.Copy(io.Discard, w.Body)
}
