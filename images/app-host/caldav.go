// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

// calPrefix is where the CalDAV relay answers. The app is told it as its
// CalDAV server's address; below it are the home's paths below the address
// the platform names for the calendar home.
const calPrefix = "/caldav"

// calMethods are what a CalDAV client sends to read and write events and
// tasks; nothing else is passed: no calendar is made, renamed or shared.
var calMethods = map[string]bool{
	"PROPFIND": true, "REPORT": true, "GET": true, "HEAD": true, "PUT": true, "DELETE": true,
}

// calHeaders are the request headers a CalDAV call keeps on its way to the
// home.
var calHeaders = []string{"Depth", "If-Match", "If-None-Match", "Content-Type", "Prefer", "Brief"}

// calQuery asks where a person's principal and calendars are.
const calQuery = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:current-user-principal/><c:calendar-home-set/></d:prop></d:propfind>`

type calendarFinding struct {
	Responses []struct {
		Propstats []struct {
			Prop struct {
				Principal struct {
					Href string `xml:"DAV: href"`
				} `xml:"DAV: current-user-principal"`
				Home struct {
					Href string `xml:"DAV: href"`
				} `xml:"urn:ietf:params:xml:ns:caldav calendar-home-set"`
			} `xml:"DAV: prop"`
		} `xml:"DAV: propstat"`
	} `xml:"DAV: response"`
}

// findCalendars asks the home who the person is and where their calendars
// are, as every CalDAV client does (RFC 6764): current-user-principal at the
// home's address, calendar-home-set at the principal. Both must lie on the
// home's own server.
func (c *homeClient) findCalendars(ctx context.Context, token string) (principal, calendars string, err error) {
	base, err := url.Parse(c.home)
	if err != nil {
		return "", "", fmt.Errorf("the calendar home's address: %w", err)
	}
	ask := func(target string) (string, string, error) {
		req, err := http.NewRequestWithContext(ctx, "PROPFIND", target, strings.NewReader(calQuery))
		if err != nil {
			return "", "", err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Depth", "0")
		req.Header.Set("Content-Type", "application/xml")
		resp, err := c.http.Do(req)
		if err != nil {
			return "", "", err
		}
		defer resp.Body.Close()
		switch resp.StatusCode {
		case http.StatusMultiStatus:
		case http.StatusUnauthorized, http.StatusForbidden:
			return "", "", &homeError{http.StatusForbidden, "the calendar home did not accept your sign-in"}
		default:
			return "", "", fmt.Errorf("the calendar home answered %d", resp.StatusCode)
		}
		var found calendarFinding
		if err := xml.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&found); err != nil {
			return "", "", fmt.Errorf("the calendar home's answer: %w", err)
		}
		var p, h string
		for _, r := range found.Responses {
			for _, ps := range r.Propstats {
				if v := strings.TrimSpace(ps.Prop.Principal.Href); v != "" && p == "" {
					p = v
				}
				if v := strings.TrimSpace(ps.Prop.Home.Href); v != "" && h == "" {
					h = v
				}
			}
		}
		return p, h, nil
	}
	own := func(href string) (string, error) {
		u, err := base.Parse(href)
		if err != nil || u.Scheme != base.Scheme || u.Host != base.Host {
			return "", &homeError{http.StatusBadGateway, "the calendar home named a place on another server"}
		}
		return withSlash(path.Clean(u.Path)), nil
	}
	p, h, err := ask(c.home)
	if err != nil {
		return "", "", err
	}
	if p == "" {
		return "", "", &homeError{http.StatusBadGateway, "the calendar home did not say who you are"}
	}
	if principal, err = own(p); err != nil {
		return "", "", err
	}
	if h == "" {
		target := *base
		target.Path, target.RawPath = principal, ""
		if _, h, err = ask(target.String()); err != nil {
			return "", "", err
		}
	}
	if h == "" {
		return "", "", &homeError{http.StatusBadGateway, "the calendar home has no calendars for you"}
	}
	if calendars, err = own(h); err != nil {
		return "", "", err
	}
	return principal, calendars, nil
}

func withSlash(p string) string {
	if strings.HasSuffix(p, "/") {
		return p
	}
	return p + "/"
}

// calRoutes adds the CalDAV relay.
func (s *server) calRoutes() {
	s.mux.HandleFunc(calPrefix+"/", s.calRelay)
	s.mux.HandleFunc(calPrefix, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, calPrefix+"/", http.StatusPermanentRedirect)
	})
}

// calRelay passes one CalDAV call of the app to the person's calendars at
// the calendar home, as the person. It reaches three places and nothing
// else the home has: its address and the person's principal, each asked
// about itself only, and the person's calendars.
func (s *server) calRelay(w http.ResponseWriter, r *http.Request) {
	if !fromTheApp(w, r) {
		return
	}
	if r.Method == http.MethodOptions {
		w.Header().Set("Allow", "OPTIONS, PROPFIND, REPORT, GET, HEAD, PUT, DELETE")
		w.Header().Set("DAV", "1, calendar-access")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !calMethods[r.Method] {
		fail(w, http.StatusMethodNotAllowed, "not a call this relay passes")
		return
	}
	rel, ok := underPrefix(r.URL.Path, calPrefix)
	if !ok {
		fail(w, http.StatusBadRequest, "no such calendar")
		return
	}
	if !s.calendars.granted() {
		fail(w, http.StatusServiceUnavailable, "this workspace has no place for calendars")
		return
	}
	base, err := url.Parse(s.calendars.home)
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "this workspace has no place for calendars")
		return
	}
	token := bearer(r)
	if token == "" {
		fail(w, http.StatusUnauthorized, "no sign-in")
		return
	}
	session, err := s.calendars.sessionFor(r.Context(), token)
	if err != nil {
		log.Printf("calendar session: %v", err)
		var he *homeError
		if errors.As(err, &he) {
			fail(w, he.status, he.message)
			return
		}
		fail(w, http.StatusBadGateway, "the place for calendars did not answer")
		return
	}

	basePath := withSlash(base.Path)
	target := basePath + rel
	depth := r.Header.Get("Depth")
	switch {
	case strings.HasPrefix(withSlash(target), session.calendars):
	case withSlash(target) == basePath || withSlash(target) == session.principal:
		// Who the person is and where their calendars are, and no listing
		// of what else the home keeps.
		if r.Method != "PROPFIND" {
			fail(w, http.StatusMethodNotAllowed, "not a call this relay passes")
			return
		}
		depth = "0"
	default:
		fail(w, http.StatusNotFound, "no such calendar")
		return
	}
	if r.ContentLength > s.cfg.maxBytes {
		fail(w, http.StatusRequestEntityTooLarge, "the entry is too large")
		return
	}

	var body io.Reader = http.NoBody
	if r.Body != nil && r.ContentLength != 0 {
		body = http.MaxBytesReader(w, r.Body, s.cfg.maxBytes)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	out := *base
	out.Path, out.RawPath, out.RawQuery = "", "", ""
	req, err := http.NewRequestWithContext(ctx, r.Method, out.String()+escapePath(target), body)
	if err != nil {
		fail(w, http.StatusBadRequest, "no such calendar")
		return
	}
	req.ContentLength = r.ContentLength
	for _, k := range calHeaders {
		if v := r.Header.Get(k); v != "" {
			req.Header.Set(k, v)
		}
	}
	if depth != "" {
		req.Header.Set("Depth", depth)
	}
	req.Header.Set("Authorization", "Bearer "+session.token)
	resp, err := s.calendars.http.Do(req)
	if err != nil {
		log.Printf("calendar relay: %v", err)
		fail(w, http.StatusBadGateway, "the place for calendars did not answer")
		return
	}
	defer resp.Body.Close()
	answer(w, r, resp, strings.TrimSuffix(basePath, "/"), calPrefix, s.cfg.maxBytes, "text/calendar")
}
