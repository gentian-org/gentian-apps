// SPDX-License-Identifier: MIT

package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

//go:embed page.html
var pageHTML []byte

//go:embed page.js
var pageJS []byte

//go:embed page.css
var pageCSS []byte

type server struct {
	cfg   config
	mux   *http.ServeMux
	homes *homeClient
}

func newServer(cfg config) http.Handler {
	s := &server{cfg: cfg, mux: http.NewServeMux(), homes: newHomeClient(cfg)}
	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok\n")
	})
	if cfg.mode == "relay" {
		s.relayRoutes()
		return s
	}
	s.mux.HandleFunc("GET /{$}", s.page)
	s.mux.HandleFunc("GET /favicon.ico", s.icon)
	s.mux.HandleFunc("GET /host/page.js", asset(pageJS, "text/javascript; charset=utf-8"))
	s.mux.HandleFunc("GET /host/page.css", asset(pageCSS, "text/css; charset=utf-8"))
	s.mux.HandleFunc("GET /host/config", s.hostConfig)
	s.mux.HandleFunc("GET /files/list", s.guard(s.list))
	s.mux.HandleFunc("GET /files/content", s.guard(s.read))
	s.mux.HandleFunc("PUT /files/content", s.guard(s.write))
	s.mux.Handle("GET /app/", http.StripPrefix("/app", http.HandlerFunc(s.static)))
	return s
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	s.mux.ServeHTTP(w, r)
}

// hasHome reports whether the tenant grants a home now: an address, and the
// scope to ask the realm for.
func (s *server) hasHome() bool {
	return s.cfg.home != "" && s.homes.scope() != ""
}

// page is the page that frames the app, or the app itself while there is no
// home to open and save at.
func (s *server) page(w http.ResponseWriter, r *http.Request) {
	if !s.hasHome() {
		http.Redirect(w, r, "/app/", http.StatusFound)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	// The page loads its own script and style, frames the app of this
	// address and calls this address. Nothing else.
	h.Set("Content-Security-Policy",
		"default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'")
	_, _ = w.Write(pageHTML)
}

// icon is the app's own icon, which its build names by content.
func (s *server) icon(w http.ResponseWriter, r *http.Request) {
	found, _ := filepath.Glob(filepath.Join(s.cfg.site, "*.ico"))
	if len(found) == 0 {
		// Not every app's build has one; the browser asks all the same.
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, found[0])
}

func asset(body []byte, contentType string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(body)
	}
}

// hostConfig tells the page which app it frames and who is at it.
func (s *server) hostConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"app":        s.cfg.app,
		"title":      s.cfg.title,
		"extensions": s.cfg.extensions,
		"person":     r.Header.Get("x-gentian-name"),
	})
}

// guard admits a file call only from this address's own page. The header is
// one a page of another site cannot send without the browser asking first,
// and a navigation never carries it: a file of the home is never rendered
// as a document of this address.
func (s *server) guard(next func(http.ResponseWriter, *http.Request, *homeSession)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Craft-Host") != "1" {
			fail(w, http.StatusForbidden, "not a call of this page")
			return
		}
		if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
			fail(w, http.StatusForbidden, "not a call of this page")
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
		next(w, r, session)
	}
}

func (s *server) list(w http.ResponseWriter, r *http.Request, session *homeSession) {
	p, ok := cleanPath(r.URL.Query().Get("path"))
	if !ok {
		fail(w, http.StatusBadRequest, "no such folder")
		return
	}
	entries, err := s.homes.list(r.Context(), session, p)
	if err != nil {
		s.homeFailed(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": p, "entries": entries})
}

func (s *server) read(w http.ResponseWriter, r *http.Request, session *homeSession) {
	p, ok := cleanPath(r.URL.Query().Get("path"))
	if !ok || p == "/" {
		fail(w, http.StatusBadRequest, "no such file")
		return
	}
	resp, err := s.homes.get(r.Context(), session, p)
	if err != nil {
		s.homeFailed(w, err)
		return
	}
	defer resp.Body.Close()
	h := w.Header()
	// Bytes for the page's script and nothing a browser renders.
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Disposition", "attachment")
	h.Set("Content-Security-Policy", "sandbox")
	h.Set("Cache-Control", "no-store")
	if etag := resp.Header.Get("ETag"); etag != "" {
		h.Set("ETag", etag)
	}
	if n := resp.Header.Get("Content-Length"); n != "" {
		h.Set("Content-Length", n)
	}
	_, _ = io.Copy(w, io.LimitReader(resp.Body, s.cfg.maxBytes))
}

func (s *server) write(w http.ResponseWriter, r *http.Request, session *homeSession) {
	p, ok := cleanPath(r.URL.Query().Get("path"))
	if !ok || p == "/" {
		fail(w, http.StatusBadRequest, "no such file")
		return
	}
	if r.ContentLength > s.cfg.maxBytes {
		fail(w, http.StatusRequestEntityTooLarge, "the file is too large")
		return
	}
	body := http.MaxBytesReader(w, r.Body, s.cfg.maxBytes)
	etag, err := s.homes.put(r.Context(), session, p, body, r.ContentLength,
		r.Header.Get("If-Match"), r.Header.Get("If-None-Match"))
	if err != nil {
		s.homeFailed(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": p, "etag": etag})
}

func (s *server) homeFailed(w http.ResponseWriter, err error) {
	var he *homeError
	if errors.As(err, &he) {
		fail(w, he.status, he.message)
		return
	}
	log.Printf("home: %v", err)
	fail(w, http.StatusBadGateway, "the place for files did not answer")
}

// static serves the app's build. A file compressed at build time is sent as
// it is to a browser that takes gzip; the files named by their content are
// kept, the entry page is asked for again.
func (s *server) static(w http.ResponseWriter, r *http.Request) {
	rel := path.Clean("/" + r.URL.Path)
	if strings.HasSuffix(r.URL.Path, "/") || rel == "/" {
		rel = path.Join(rel, "index.html")
	}
	file := filepath.Join(s.cfg.site, filepath.FromSlash(rel))
	info, err := os.Stat(file)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	switch path.Ext(rel) {
	case ".html":
		h.Set("Cache-Control", "no-cache")
	case ".wasm", ".js", ".ttf":
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	if ct := contentTypes[path.Ext(rel)]; ct != "" {
		h.Set("Content-Type", ct)
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

var contentTypes = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".wasm": "application/wasm",
	".css":  "text/css; charset=utf-8",
	".json": "application/json",
	".svg":  "image/svg+xml",
	".png":  "image/png",
	".ico":  "image/x-icon",
	".ttf":  "font/ttf",
}

// cleanPath is a path of the person's files as the page names it: absolute,
// with no step upwards.
func cleanPath(p string) (string, bool) {
	if p == "" {
		p = "/"
	}
	if !strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\x00\\") {
		return "", false
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".." || part == "." {
			return "", false
		}
	}
	c := path.Clean(p)
	return c, true
}

func bearer(r *http.Request) string {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if len(h) > len(prefix) && strings.EqualFold(h[:len(prefix)], prefix) {
		return strings.TrimSpace(h[len(prefix):])
	}
	return ""
}

func splitList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, strings.ToLower(part))
		}
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func fail(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
