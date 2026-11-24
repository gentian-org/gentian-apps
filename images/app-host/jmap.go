// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"regexp"
	"strings"
	"time"
)

// The "jmap" mode serves an app that reads a JMAP mail server (RFC 8620,
// 8621) itself, from the browser: MailCraft's browser build. The app is
// served at the root as upstream ships it, with one script put in at the top
// of its entry page. That script names the person's account at the tenant's
// mail server, and gives the app, each time it asks, the token the tenant's
// edge handed this request for the person. The app then talks JMAP to the
// mail server directly; nothing of the person's mail passes this pod.
//
// The pod keeps no token. The one it hands over is the edge's for this app,
// short-lived and renewed by the edge with the person's session; the page
// holds it in memory for one job of the app at a time.
//
// The mail server has to accept that token (it is checked at the tenant's
// realm, by introspection or userinfo), and has to let this app's address
// in (CORS). Both are set at the mail server, not here.

// jmapScriptPath is the script the entry page loads before the app starts.
const jmapScriptPath = "/host/jmap.js"

// jmapTokenPath is where the script asks for the token, on each job of the
// app.
const jmapTokenPath = "/host/jmap-token"

func (s *server) jmapRoutes() {
	s.mux.HandleFunc("GET "+jmapScriptPath, s.jmapScript)
	s.mux.HandleFunc("GET "+jmapTokenPath, s.jmapToken)
	// Without a method: GET / would conflict with the patterns above. The
	// app refuses what is not a read itself.
	s.mux.HandleFunc("/", s.jmapApp)
}

// jmapSession is the address of the mail server's JMAP session resource:
// the one the pod is told, or else https://<IMAP host>/jmap/session, where a
// server that serves both from one name (Stalwart) answers it. Empty while
// the tenant's mail is on no server outside the cluster.
func (s *server) jmapSession() string {
	if s.cfg.jmapSession != "" {
		return s.cfg.jmapSession
	}
	host := strings.TrimSpace(s.cfg.jmapIMAPHost)
	if host == "" || !validHost.MatchString(host) {
		return ""
	}
	return "https://" + host + "/jmap/session"
}

// validHost is a DNS name, nothing that could carry a path or a port.
var validHost = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$`)

// jmapScript names the person's account to the app. Without a mail server
// or without a person's address it names nothing, and the app starts as
// upstream ships it.
func (s *server) jmapScript(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Content-Type", "text/javascript; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	session := s.jmapSession()
	email := strings.TrimSpace(r.Header.Get("x-gentian-email"))
	if session == "" || email == "" || !strings.Contains(email, "@") {
		_, _ = w.Write([]byte("// No mail server is named for this workspace.\n"))
		return
	}
	name := strings.TrimSpace(r.Header.Get("x-gentian-name"))
	if name == "" {
		name = email
	}
	account, _ := json.Marshal(map[string]any{
		"email": email, "session": session, "bearer": true, "name": name,
	})
	tokenPath, _ := json.Marshal(jmapTokenPath)
	var b bytes.Buffer
	b.WriteString("// Written by the host for the person at this page: their account at the\n")
	b.WriteString("// workspace's mail server, and where the token the app signs in with is asked\n")
	b.WriteString("// for on each of its jobs.\n")
	b.WriteString("window.mailcraftJmap = {\n  accounts: [")
	b.Write(account)
	b.WriteString("],\n  secret: function () {\n    return fetch(")
	b.Write(tokenPath)
	b.WriteString(", {headers: {\"X-Craft-Host\": \"1\"}, cache: \"no-store\", credentials: \"same-origin\"})\n")
	b.WriteString("      .then(function (r) { if (!r.ok) { throw new Error(\"no sign-in: \" + r.status); } return r.json(); })\n")
	b.WriteString("      .then(function (j) { return j.token; });\n  },\n};\n")
	_, _ = w.Write(b.Bytes())
}

// jmapToken gives this address's own script the token the edge handed this
// request for the person. Only to the page's script: never a navigation,
// never a call from another site, and only with the header a page of
// another site cannot send without the browser asking first.
func (s *server) jmapToken(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Craft-Host") != "1" || r.Header.Get("Sec-Fetch-Mode") == "navigate" {
		fail(w, http.StatusForbidden, "not a call of this page")
		return
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		fail(w, http.StatusForbidden, "not a call of this page")
		return
	}
	if s.jmapSession() == "" {
		fail(w, http.StatusNotFound, "this workspace names no mail server")
		return
	}
	token := bearer(r)
	if token == "" {
		fail(w, http.StatusUnauthorized, "no sign-in")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token})
}

// jmapApp serves the app's build at the root, with the entry page carrying
// the script that names the account. Any other file is served as it is.
func (s *server) jmapApp(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		fail(w, http.StatusMethodNotAllowed, "the app is only read")
		return
	}
	site, err := os.OpenRoot(s.cfg.site)
	if err != nil {
		log.Printf("site: %v", err)
		http.NotFound(w, r)
		return
	}
	defer site.Close()
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if f, _ := openFile(site, name); f != nil {
		f.Close()
		if name != "index.html" {
			s.app(w, r)
			return
		}
	}
	// The entry page, for its own address and for any of the app's routes.
	f, err := site.Open("index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	page, err := io.ReadAll(io.LimitReader(f, 1<<20))
	f.Close()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	// What upstream asks of its host: a page this one opens is cut off from it.
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	out := withScript(page, jmapScriptPath)
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(out))
}

var headOpen = regexp.MustCompile(`(?i)<head(\s[^>]*)?>`)

// withScript puts a classic script first in the page's head. A classic
// script runs before the page's module scripts, so what it sets is there
// when the app starts.
func withScript(page []byte, src string) []byte {
	tag := []byte(`<script src="` + src + `"></script>`)
	loc := headOpen.FindIndex(page)
	if loc == nil {
		return append(append(tag, '\n'), page...)
	}
	out := make([]byte, 0, len(page)+len(tag)+1)
	out = append(out, page[:loc[1]]...)
	out = append(out, '\n')
	out = append(out, tag...)
	out = append(out, page[loc[1]:]...)
	return out
}
