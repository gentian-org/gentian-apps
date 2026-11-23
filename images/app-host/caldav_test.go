// SPDX-License-Identifier: MIT

package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// calHome is a calendar home in memory laid out as Nextcloud's: the DAV
// root names the principal, the principal names the calendar home, and the
// person's files sit beside them under files/, which the relay never reaches.
type calHome struct {
	mu        sync.Mutex
	seen      []string
	depths    []string
	elsewhere bool // names a principal on another server
	events    map[string]string
}

func (h *calHome) ServeHTTP(rw http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seen = append(h.seen, r.Method+" "+r.URL.Path)
	h.depths = append(h.depths, r.Header.Get("Depth"))
	if r.Header.Get("Authorization") != "Bearer "+homeToken {
		rw.WriteHeader(http.StatusUnauthorized)
		return
	}
	multi := func(body string) {
		rw.WriteHeader(http.StatusMultiStatus)
		_, _ = io.WriteString(rw, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">`+body+`</d:multistatus>`)
	}
	resp := func(href, props string) string {
		return `<d:response><d:href>` + href + `</d:href><d:propstat><d:prop>` + props + `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
	}
	p := r.URL.Path
	switch {
	case p == "/remote.php/dav/" && r.Method == "PROPFIND":
		principal := "/remote.php/dav/principals/users/ada/"
		if h.elsewhere {
			principal = "https://evil.example/principals/ada/"
		}
		multi(resp("/remote.php/dav/", `<d:current-user-principal><d:href>`+principal+`</d:href></d:current-user-principal>`))
	case p == "/remote.php/dav/principals/users/ada/" && r.Method == "PROPFIND":
		multi(resp(p, `<c:calendar-home-set><d:href>/remote.php/dav/calendars/ada/</d:href></c:calendar-home-set>`))
	case p == "/remote.php/dav/calendars/ada/" && r.Method == "PROPFIND":
		multi(resp(p, `<d:resourcetype><d:collection/></d:resourcetype>`) +
			resp("/remote.php/dav/calendars/ada/personal/", `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>`))
	case p == "/remote.php/dav/calendars/ada/personal/" && r.Method == "REPORT":
		var b strings.Builder
		for name, ics := range h.events {
			b.WriteString(resp("/remote.php/dav/calendars/ada/personal/"+name, `<d:getetag>"1"</d:getetag><c:calendar-data>`+ics+`</c:calendar-data>`))
		}
		multi(b.String())
	case strings.HasPrefix(p, "/remote.php/dav/calendars/ada/personal/") && r.Method == "GET":
		ics, ok := h.events[strings.TrimPrefix(p, "/remote.php/dav/calendars/ada/personal/")]
		if !ok {
			rw.WriteHeader(http.StatusNotFound)
			return
		}
		rw.Header().Set("Content-Type", "text/calendar; charset=utf-8")
		rw.Header().Set("ETag", `"1"`)
		_, _ = io.WriteString(rw, ics)
	case strings.HasPrefix(p, "/remote.php/dav/calendars/ada/personal/") && r.Method == "PUT":
		name := strings.TrimPrefix(p, "/remote.php/dav/calendars/ada/personal/")
		if _, exists := h.events[name]; exists && r.Header.Get("If-None-Match") == "*" {
			rw.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		body, _ := io.ReadAll(r.Body)
		h.events[name] = string(body)
		rw.Header().Set("ETag", `"2"`)
		rw.WriteHeader(http.StatusCreated)
	default:
		// Whatever else the home keeps answers too: the relay must not ask.
		multi(resp(p, `<d:resourcetype><d:collection/></d:resourcetype>`))
	}
}

func newCalWorld(t *testing.T, granted bool) (*relayWorld, *calHome) {
	t.Helper()
	w := newRelayWorld(t, true)
	cal := &calHome{events: map[string]string{"task-1.ics": "BEGIN:VCALENDAR\nBEGIN:VTODO\nUID:task-1\nEND:VTODO\nEND:VCALENDAR"}}
	srv := httptest.NewServer(cal)
	t.Cleanup(srv.Close)
	cfg := w.handler.(*server).cfg
	if granted {
		cfg.calendarHome = srv.URL + "/remote.php/dav/"
		cfg.calendarScope = "home-calendars"
	}
	w.handler = newServer(cfg)
	return w, cal
}

func TestCalendarClientFindsTheCalendarsThroughTheRelay(t *testing.T) {
	w, cal := newCalWorld(t, true)

	// Discovery as the app's client does it, from the address it is told.
	rec := w.call("PROPFIND", "/caldav/", "<propfind/>", map[string]string{"Depth": "1"})
	if rec.Code != http.StatusMultiStatus || !strings.Contains(rec.Body.String(), "<d:href>/caldav/principals/users/ada/</d:href>") {
		t.Fatalf("the root: %d %s", rec.Code, rec.Body.String())
	}
	rec = w.call("PROPFIND", "/caldav/principals/users/ada/", "<propfind/>", map[string]string{"Depth": "0"})
	if rec.Code != http.StatusMultiStatus || !strings.Contains(rec.Body.String(), "<d:href>/caldav/calendars/ada/</d:href>") {
		t.Fatalf("the principal: %d %s", rec.Code, rec.Body.String())
	}
	rec = w.call("PROPFIND", "/caldav/calendars/ada/", "<propfind/>", map[string]string{"Depth": "1"})
	if rec.Code != http.StatusMultiStatus || !strings.Contains(rec.Body.String(), "<d:href>/caldav/calendars/ada/personal/</d:href>") {
		t.Fatalf("the calendars: %d %s", rec.Code, rec.Body.String())
	}
	rec = w.call("REPORT", "/caldav/calendars/ada/personal/", "<c:calendar-query/>", map[string]string{"Depth": "1"})
	if rec.Code != http.StatusMultiStatus || !strings.Contains(rec.Body.String(), "/caldav/calendars/ada/personal/task-1.ics") || !strings.Contains(rec.Body.String(), "VTODO") {
		t.Fatalf("the report: %d %s", rec.Code, rec.Body.String())
	}
	rec = w.call("GET", "/caldav/calendars/ada/personal/task-1.ics", "", nil)
	if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/calendar") || rec.Header().Get("ETag") != `"1"` {
		t.Fatalf("an entry: %d %v", rec.Code, rec.Header())
	}
	if rec.Header().Get("Content-Security-Policy") != "sandbox" {
		t.Fatalf("an entry is rendered by nobody: %v", rec.Header())
	}
	rec = w.call("PUT", "/caldav/calendars/ada/personal/task-2.ics", "BEGIN:VCALENDAR", map[string]string{"If-None-Match": "*", "Content-Type": "text/calendar"})
	if rec.Code != http.StatusCreated || cal.events["task-2.ics"] != "BEGIN:VCALENDAR" {
		t.Fatalf("a new entry: %d", rec.Code)
	}
	rec = w.call("PUT", "/caldav/calendars/ada/personal/task-2.ics", "again", map[string]string{"If-None-Match": "*"})
	if rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("a condition of the app's: %d", rec.Code)
	}

	// The root and the principal are asked about themselves only.
	for i, s := range cal.seen {
		if (s == "PROPFIND /remote.php/dav/" || s == "PROPFIND /remote.php/dav/principals/users/ada/") && cal.depths[i] != "0" {
			t.Fatalf("%s asked with depth %q", s, cal.depths[i])
		}
	}
}

func TestCalendarRelayReachesNothingElseOfTheHome(t *testing.T) {
	w, cal := newCalWorld(t, true)
	for _, c := range []struct {
		method, target string
		want           int
	}{
		{"PROPFIND", "/caldav/files/ada/", http.StatusNotFound},
		{"GET", "/caldav/files/ada/private.txt", http.StatusNotFound},
		{"PROPFIND", "/caldav/principals/users/", http.StatusNotFound},
		{"PROPFIND", "/caldav/calendars/bob/", http.StatusNotFound},
		// A step upwards is cleaned away before the relay sees it: the
		// server sends the client to the clean path (301 or 307, by Go's
		// version).
		{"PROPFIND", "/caldav/calendars/ada/../../files/ada/", http.StatusMovedPermanently},
		{"PROPFIND", "/caldav/calendars/ada/%2e%2e/%2e%2e/files/ada/", http.StatusBadRequest},
		{"GET", "/caldav/", http.StatusMethodNotAllowed},
		{"REPORT", "/caldav/principals/users/ada/", http.StatusMethodNotAllowed},
		{"MKCALENDAR", "/caldav/calendars/ada/new/", http.StatusMethodNotAllowed},
		{"PROPPATCH", "/caldav/calendars/ada/personal/", http.StatusMethodNotAllowed},
	} {
		rec := w.call(c.method, c.target, "", nil)
		if c.want == http.StatusMovedPermanently && rec.Code/100 == 3 {
			continue
		}
		if rec.Code != c.want {
			t.Errorf("%s %s: %d, want %d", c.method, c.target, rec.Code, c.want)
		}
	}
	for _, s := range cal.seen {
		if strings.Contains(s, "/files/") || strings.Contains(s, "/bob/") || s == "PROPFIND /remote.php/dav/principals/users/" {
			t.Fatalf("the relay asked the home for %s", s)
		}
	}
	// Not the app's own call: a page navigated to, another site.
	if rec := w.call("GET", "/caldav/calendars/ada/personal/task-1.ics", "", map[string]string{"Sec-Fetch-Mode": "navigate"}); rec.Code != http.StatusForbidden {
		t.Fatalf("a navigation: %d", rec.Code)
	}
	if rec := w.call("REPORT", "/caldav/calendars/ada/personal/", "", map[string]string{"Sec-Fetch-Site": "cross-site"}); rec.Code != http.StatusForbidden {
		t.Fatalf("another site: %d", rec.Code)
	}
}

func TestCalendarRelayWithoutACalendarHome(t *testing.T) {
	w, _ := newCalWorld(t, false)
	if rec := w.call("PROPFIND", "/caldav/", "", nil); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("without a calendar home: %d", rec.Code)
	}
	// The file relay is the file home's and goes on.
	if rec := w.call("PROPFIND", "/webdav/", "", map[string]string{"Depth": "1"}); rec.Code != http.StatusMultiStatus {
		t.Fatalf("the file relay: %d", rec.Code)
	}
}

func TestCalendarHomeNamingAnotherServerIsRefused(t *testing.T) {
	w, cal := newCalWorld(t, true)
	cal.elsewhere = true
	if rec := w.call("PROPFIND", "/caldav/", "", nil); rec.Code != http.StatusBadGateway {
		t.Fatalf("a principal elsewhere: %d", rec.Code)
	}
}
