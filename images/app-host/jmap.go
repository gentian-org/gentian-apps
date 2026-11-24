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
// mail server; the app asks the person for their password there, keeps it in
// the page's memory and talks JMAP to the server directly. Nothing of the
// person's mail and no credential passes this pod.
//
// The mail server has to let this app's address in (CORS). That is set at
// the mail server, not here.

// jmapScriptPath is the script the entry page loads before the app starts.
const jmapScriptPath = "/host/jmap.js"

func (s *server) jmapRoutes() {
	s.mux.HandleFunc("GET "+jmapScriptPath, s.jmapScript)
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
	// bearer false and no secret: the app asks the person for their password
	// at the server, as for any JMAP account, and keeps it in memory only.
	account, _ := json.Marshal(map[string]any{
		"email": email, "session": session, "bearer": false, "name": name,
	})
	var b bytes.Buffer
	b.WriteString("// Written by the host for the person at this page: their account at the\n")
	b.WriteString("// workspace's mail server. The app asks them for its password.\n")
	b.WriteString("window.mailcraftJmap = {\n  accounts: [")
	b.Write(account)
	b.WriteString("],\n};\n")
	_, _ = w.Write(b.Bytes())
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
