// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// davPrefix is where the relay answers. The app is told it as its WebDAV
// server's address.
const davPrefix = "/webdav"

// relayMethods are what a WebDAV sync client sends; nothing else is passed.
var relayMethods = map[string]bool{
	"PROPFIND": true, "GET": true, "HEAD": true, "PUT": true, "DELETE": true, "MKCOL": true,
}

// relayHeaders are the request headers a call keeps on its way to the home.
// Not the client's Authorization: the relay signs in as the person itself.
var relayHeaders = []string{"Depth", "If-Match", "If-None-Match", "Content-Type"}

// answerHeaders are the home's answer headers the app is given back.
var answerHeaders = []string{"ETag", "Last-Modified", "DAV"}

func (s *server) relayRoutes() {
	s.mux.HandleFunc(davPrefix+"/", s.relay)
	s.mux.HandleFunc(davPrefix, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, davPrefix+"/", http.StatusPermanentRedirect)
	})
	if s.cfg.settingsPath != "" {
		s.mux.HandleFunc("GET "+s.cfg.settingsPath, s.settings)
	}
	// Without a method: a pattern for GET would conflict with the relay's,
	// which takes every method. The app refuses what is not a read itself.
	s.mux.HandleFunc("/", s.app)
}

// app serves the build at this address's root. A path that names no file is
// one of the app's own routes and gets its entry page.
func (s *server) app(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		fail(w, http.StatusMethodNotAllowed, "the app is only read")
		return
	}
	rel := path.Clean("/" + r.URL.Path)
	file := filepath.Join(s.cfg.site, filepath.FromSlash(rel))
	if info, err := os.Stat(file); err != nil || info.IsDir() {
		rel = "/index.html"
		file = filepath.Join(s.cfg.site, "index.html")
	}
	h := w.Header()
	switch path.Ext(rel) {
	case ".html", ".json", ".webmanifest":
		// The entry page, the service worker's manifest and the app's
		// settings: asked for again each time.
		h.Set("Cache-Control", "no-cache")
	}
	if ct := contentTypes[path.Ext(rel)]; ct != "" {
		h.Set("Content-Type", ct)
	} else if ct := mime.TypeByExtension(path.Ext(rel)); ct != "" {
		h.Set("Content-Type", ct)
	}
	info, err := os.Stat(file)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		if gz, err := os.Open(file + ".gz"); err == nil {
			defer gz.Close()
			h.Set("Content-Encoding", "gzip")
			h.Add("Vary", "Accept-Encoding")
			http.ServeContent(w, r, "", info.ModTime(), gz)
			return
		}
	}
	http.ServeFile(w, r, file)
}

// settings are the app's default settings, which point its WebDAV sync at
// this address's relay. Only while there is a home to relay to: without one
// the app finds none and starts as upstream ships it.
func (s *server) settings(w http.ResponseWriter, r *http.Request) {
	if !s.hasHome() {
		http.NotFound(w, r)
		return
	}
	tmpl, err := os.ReadFile(s.cfg.settingsTemplate)
	if err != nil {
		log.Printf("settings: %v", err)
		http.NotFound(w, r)
		return
	}
	scheme := r.Header.Get("X-Forwarded-Proto")
	if scheme != "http" {
		scheme = "https"
	}
	name := r.Header.Get("x-gentian-email")
	if name == "" {
		name = "me"
	}
	out := strings.NewReplacer(
		"{{origin}}", jsonText(scheme+"://"+r.Host),
		"{{folder}}", jsonText(s.cfg.davFolder),
		"{{name}}", jsonText(name),
	).Replace(string(tmpl))
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, out)
}

// jsonText is s as it may stand between the quotes of a JSON string.
func jsonText(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '"' || r == '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r < 0x20:
			// Nothing a host name, a folder or an address holds.
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// relay passes one WebDAV call of the app to the person's folder at the
// home, as the person.
func (s *server) relay(w http.ResponseWriter, r *http.Request) {
	// A call of the app's own script, never a page a browser navigates to:
	// a file of the home is not rendered as a document of this address.
	if r.Header.Get("Sec-Fetch-Mode") == "navigate" {
		fail(w, http.StatusForbidden, "not a call of this app")
		return
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		fail(w, http.StatusForbidden, "not a call of this app")
		return
	}
	if r.Method == http.MethodOptions {
		w.Header().Set("Allow", "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL")
		w.Header().Set("DAV", "1")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !relayMethods[r.Method] {
		fail(w, http.StatusMethodNotAllowed, "not a call this relay passes")
		return
	}
	rel, ok := relayPath(r.URL.Path)
	if !ok {
		fail(w, http.StatusBadRequest, "no such file")
		return
	}
	if !s.hasHome() {
		fail(w, http.StatusServiceUnavailable, "this workspace has no place for files")
		return
	}
	token := bearer(r)
	if token == "" {
		fail(w, http.StatusUnauthorized, "no sign-in")
		return
	}
	session, err := s.homes.sessionFor(r.Context(), token)
	if err != nil {
		log.Printf("home session: %v", err)
		var he *homeError
		if errors.As(err, &he) {
			fail(w, he.status, he.message)
			return
		}
		fail(w, http.StatusBadGateway, "the place for files did not answer")
		return
	}
	if r.ContentLength > s.cfg.maxBytes {
		fail(w, http.StatusRequestEntityTooLarge, "the file is too large")
		return
	}
	folder := session.address("/"+s.cfg.davFolder) + "/"
	if err := s.homes.ensureFolder(r.Context(), session, folder); err != nil {
		s.homeFailed(w, err)
		return
	}

	var body io.Reader = http.NoBody
	if r.Body != nil && r.ContentLength != 0 {
		body = http.MaxBytesReader(w, r.Body, s.cfg.maxBytes)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, r.Method, folder+escapePath(rel), body)
	if err != nil {
		fail(w, http.StatusBadRequest, "no such file")
		return
	}
	req.ContentLength = r.ContentLength
	for _, k := range relayHeaders {
		if v := r.Header.Get(k); v != "" {
			req.Header.Set(k, v)
		}
	}
	req.Header.Set("Authorization", "Bearer "+session.token)
	resp, err := s.homes.http.Do(req)
	if err != nil {
		log.Printf("relay: %v", err)
		fail(w, http.StatusBadGateway, "the place for files did not answer")
		return
	}
	defer resp.Body.Close()

	h := w.Header()
	for _, k := range answerHeaders {
		if v := resp.Header.Get(k); v != "" {
			h.Set(k, v)
		}
	}
	h.Set("Cache-Control", "no-store")
	// Bytes for the app's script, and nothing a browser renders.
	h.Set("Content-Security-Policy", "sandbox")
	status := resp.StatusCode
	if status == http.StatusUnauthorized {
		// The person's sign-in was good at the edge and the realm; the home
		// refusing it is a refusal, not a question for a password.
		status = http.StatusForbidden
	}
	if resp.StatusCode == http.StatusMultiStatus {
		listing, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		if err != nil {
			fail(w, http.StatusBadGateway, "the place for files did not answer")
			return
		}
		out := rewriteHrefs(listing, pathOf(folder))
		h.Set("Content-Type", "application/xml; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write(out)
		return
	}
	h.Set("Content-Type", "application/octet-stream")
	if n := resp.Header.Get("Content-Length"); n != "" {
		h.Set("Content-Length", n)
	}
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, io.LimitReader(resp.Body, s.cfg.maxBytes))
	}
}

// relayPath is the path below the relay's address: decoded, with no step
// upwards. A trailing slash, which names a folder, is kept.
func relayPath(p string) (string, bool) {
	rel := strings.TrimPrefix(p, davPrefix)
	if rel == "" {
		rel = "/"
	}
	if !strings.HasPrefix(rel, "/") || strings.ContainsAny(rel, "\x00\\") {
		return "", false
	}
	for _, part := range strings.Split(rel, "/") {
		if part == ".." || part == "." {
			return "", false
		}
	}
	return strings.TrimPrefix(rel, "/"), true
}

// escapePath escapes each step of a path, keeping its slashes.
func escapePath(p string) string {
	parts := strings.Split(p, "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return strings.Join(parts, "/")
}

var hrefElement = regexp.MustCompile(`(<(?:[A-Za-z][\w.-]*:)?href>)([^<]*)(</(?:[A-Za-z][\w.-]*:)?href>)`)

// rewriteHrefs puts the relay's addresses in place of the home's in a
// listing: the app compares them with the paths it asked for. An address
// outside the folder, which a home never lists, is left out of the
// listing's meaning by being sent to the relay's root.
func rewriteHrefs(listing []byte, folderPath string) []byte {
	base := strings.TrimSuffix(folderPath, "/")
	return hrefElement.ReplaceAllFunc(listing, func(m []byte) []byte {
		parts := hrefElement.FindSubmatch(m)
		href := pathOf(strings.TrimSpace(xmlUnescape(string(parts[2]))))
		rest := "/"
		if strings.HasPrefix(href, base+"/") {
			rest = href[len(base):]
		}
		var b bytes.Buffer
		b.Write(parts[1])
		b.WriteString(xmlEscape(davPrefix + escapePath(rest)))
		b.Write(parts[3])
		return b.Bytes()
	})
}

var xmlUnescaper = strings.NewReplacer("&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", `"`, "&apos;", "'")
var xmlEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

func xmlUnescape(s string) string { return xmlUnescaper.Replace(s) }
func xmlEscape(s string) string   { return xmlEscaper.Replace(s) }

// ensureFolder makes the relay's folder where the person's files have none,
// once for each session.
func (c *homeClient) ensureFolder(ctx context.Context, s *homeSession, folder string) error {
	c.mu.Lock()
	ready := s.folderReady
	c.mu.Unlock()
	if ready {
		return nil
	}
	_, status, err := c.propfind(ctx, s.token, folder, "0", listQuery)
	if err != nil {
		return err
	}
	switch status {
	case http.StatusMultiStatus:
	case http.StatusNotFound:
		req, err := http.NewRequestWithContext(ctx, "MKCOL", folder, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+s.token)
		resp, err := c.http.Do(req)
		if err != nil {
			return err
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		resp.Body.Close()
		// 405: somebody made it in the meantime.
		if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusMethodNotAllowed {
			return refusal(resp.StatusCode, "folder")
		}
	default:
		return refusal(status, "folder")
	}
	c.mu.Lock()
	s.folderReady = true
	c.mu.Unlock()
	return nil
}
