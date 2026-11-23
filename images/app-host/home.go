// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// homeError is a refusal a person can be told.
type homeError struct {
	status  int
	message string
}

func (e *homeError) Error() string { return e.message }

// homeSession is what one person's token at the edge is worth at the home,
// for as long as the home's token lasts.
type homeSession struct {
	token   string
	root    string // the person's files, ending in a slash
	expires time.Time
	// folderReady says the relay's folder is known to exist.
	folderReady bool
	// principal and calendars are, for a calendar home, the paths of the
	// person's principal and of their calendars (calendar-home-set), each
	// ending in a slash.
	principal string
	calendars string
}

// entry is one file or folder of a listing.
type entry struct {
	Name     string `json:"name"`
	Folder   bool   `json:"folder"`
	Size     int64  `json:"size"`
	Modified string `json:"modified,omitempty"`
	ETag     string `json:"etag,omitempty"`
}

type homeClient struct {
	cfg  config
	http *http.Client
	// home is the address the home answers at, and homeScope the scope
	// its token is issued under; both empty while the tenant grants none.
	home      string
	homeScope string
	// calendars says the home is a calendar home: a session finds the
	// person's calendars, not their files.
	calendars bool

	mu       sync.Mutex
	sessions map[[32]byte]*homeSession
}

// newHomeClient is the client of the tenant's file home.
func newHomeClient(cfg config) *homeClient {
	return newClient(cfg, cfg.home, cfg.homeScope, false)
}

// newCalendarClient is the client of the tenant's calendar home.
func newCalendarClient(cfg config) *homeClient {
	return newClient(cfg, cfg.calendarHome, cfg.calendarScope, true)
}

func newClient(cfg config, home, scope string, calendars bool) *homeClient {
	return &homeClient{
		cfg:       cfg,
		home:      home,
		homeScope: scope,
		calendars: calendars,
		http: &http.Client{
			// A person's token is sent to the home and the realm and
			// follows nobody's redirect.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		sessions: map[[32]byte]*homeSession{},
	}
}

// told reads one entry of the platform's Secret. Read each time: the
// platform changes them while the pod runs.
func (c *homeClient) told(key string) string {
	b, err := os.ReadFile(filepath.Join(c.cfg.vouching, key))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// scope is the scope the realm issues the home's token under, empty while
// the tenant grants no home.
func (c *homeClient) scope() string { return c.homeScope }

// granted reports whether the tenant grants this home now: an address, and
// the scope to ask the realm for.
func (c *homeClient) granted() bool { return c.home != "" && c.homeScope != "" }

// sessionFor exchanges the token the edge handed this request for one valid
// at the home, and finds the person's files there. Kept until the home's
// token ends, by the edge's token and nothing else: a request without that
// token gets nothing.
func (c *homeClient) sessionFor(ctx context.Context, edgeToken string) (*homeSession, error) {
	key := sha256.Sum256([]byte(edgeToken))
	now := time.Now()
	c.mu.Lock()
	for k, s := range c.sessions {
		if now.After(s.expires) {
			delete(c.sessions, k)
		}
	}
	s := c.sessions[key]
	c.mu.Unlock()
	if s != nil {
		return s, nil
	}

	token, lifetime, err := c.exchange(ctx, edgeToken)
	if err != nil {
		return nil, err
	}
	// Ended a little early, so a call in flight does not arrive expired.
	s = &homeSession{token: token, expires: now.Add(lifetime - 15*time.Second)}
	if c.calendars {
		if s.principal, s.calendars, err = c.findCalendars(ctx, token); err != nil {
			return nil, err
		}
	} else if s.root, err = c.findRoot(ctx, token); err != nil {
		return nil, err
	}
	if lifetime > 30*time.Second {
		c.mu.Lock()
		c.sessions[key] = s
		c.mu.Unlock()
	}
	return s, nil
}

// exchange is the realm's standard token exchange (RFC 8693): the person's
// token for this app, for one of the home.
func (c *homeClient) exchange(ctx context.Context, edgeToken string) (string, time.Duration, error) {
	form := url.Values{
		"grant_type":         {"urn:ietf:params:oauth:grant-type:token-exchange"},
		"client_id":          {c.told("VOUCHING_CLIENT_ID")},
		"client_secret":      {c.told("VOUCHING_CLIENT_SECRET")},
		"subject_token":      {edgeToken},
		"subject_token_type": {"urn:ietf:params:oauth:token-type:access_token"},
		"scope":              {c.scope()},
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.told("VOUCHING_TOKEN_URL"), strings.NewReader(form.Encode()))
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.http.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("token exchange: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		var refusal struct {
			Error       string `json:"error"`
			Description string `json:"error_description"`
		}
		_ = json.Unmarshal(body, &refusal)
		// The realm's words go to the log, not to the page.
		err := fmt.Errorf("token exchange: %d %s: %s", resp.StatusCode, refusal.Error, refusal.Description)
		if resp.StatusCode >= 500 {
			return "", 0, err
		}
		return "", 0, fmt.Errorf("%w: %w", &homeError{http.StatusForbidden, "the workspace gave no access to your files"}, err)
	}
	var answer struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &answer); err != nil || answer.AccessToken == "" {
		return "", 0, fmt.Errorf("token exchange: an answer with no token")
	}
	return answer.AccessToken, time.Duration(answer.ExpiresIn) * time.Second, nil
}

const principalQuery = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`

// findRoot is where the person's files are at the home. A home that keeps
// each person's files under their principal's name (files/<name>/ beside
// principals/, as Nextcloud and ownCloud do) is asked who the person is; a
// home whose address is the person's files already is used as it is.
func (c *homeClient) findRoot(ctx context.Context, token string) (string, error) {
	base := c.home
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	ms, status, err := c.propfind(ctx, token, base, "0", principalQuery)
	if err != nil {
		return "", err
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return "", &homeError{http.StatusForbidden, "the place for files did not accept your sign-in"}
	}
	if status != http.StatusMultiStatus {
		return base, nil
	}
	for _, r := range ms.Responses {
		for _, ps := range r.Propstats {
			name := path.Base(strings.TrimSuffix(decoded(ps.Prop.Principal.Href), "/"))
			if name == "" || name == "." || name == "/" {
				continue
			}
			candidate := base + "files/" + url.PathEscape(name) + "/"
			if _, status, err := c.propfind(ctx, token, candidate, "0", listQuery); err == nil && status == http.StatusMultiStatus {
				return candidate, nil
			}
		}
	}
	return base, nil
}

const listQuery = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>`

type multistatus struct {
	Responses []struct {
		Href      string `xml:"DAV: href"`
		Propstats []struct {
			Status string `xml:"DAV: status"`
			Prop   struct {
				Collection *struct{} `xml:"DAV: resourcetype>collection"`
				Length     int64     `xml:"DAV: getcontentlength"`
				Modified   string    `xml:"DAV: getlastmodified"`
				ETag       string    `xml:"DAV: getetag"`
				Principal  struct {
					Href string `xml:"DAV: href"`
				} `xml:"DAV: current-user-principal"`
			} `xml:"DAV: prop"`
		} `xml:"DAV: propstat"`
	} `xml:"DAV: response"`
}

func (c *homeClient) propfind(ctx context.Context, token, target, depth, query string) (*multistatus, int, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "PROPFIND", target, strings.NewReader(query))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Depth", depth)
	req.Header.Set("Content-Type", "application/xml")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMultiStatus {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return nil, resp.StatusCode, nil
	}
	ms := &multistatus{}
	if err := xml.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(ms); err != nil {
		return nil, 0, fmt.Errorf("the home's listing: %w", err)
	}
	return ms, resp.StatusCode, nil
}

// address is a path of the person's files as the home is asked for it.
func (s *homeSession) address(p string) string {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return s.root + strings.Join(parts, "/")
}

func (c *homeClient) list(ctx context.Context, s *homeSession, p string) ([]entry, error) {
	target := s.address(p)
	if !strings.HasSuffix(target, "/") {
		target += "/"
	}
	ms, status, err := c.propfind(ctx, s.token, target, "1", listQuery)
	if err != nil {
		return nil, err
	}
	if status != http.StatusMultiStatus {
		return nil, refusal(status, "folder")
	}
	self := strings.TrimSuffix(pathOf(target), "/")
	entries := []entry{}
	for _, r := range ms.Responses {
		href := strings.TrimSuffix(pathOf(r.Href), "/")
		if href == self {
			continue
		}
		e := entry{Name: path.Base(href)}
		for _, ps := range r.Propstats {
			if !strings.Contains(ps.Status, " 200") {
				continue
			}
			e.Folder = ps.Prop.Collection != nil
			e.Size = ps.Prop.Length
			e.Modified = ps.Prop.Modified
			e.ETag = ps.Prop.ETag
		}
		if e.Name == "" || e.Name == "." || strings.HasPrefix(e.Name, ".") {
			continue
		}
		if !e.Folder && !c.opens(e.Name) {
			continue
		}
		entries = append(entries, e)
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Folder != entries[j].Folder {
			return entries[i].Folder
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	return entries, nil
}

// opens reports whether the app opens a file of this name.
func (c *homeClient) opens(name string) bool {
	ext := strings.ToLower(path.Ext(name))
	for _, e := range c.cfg.extensions {
		if e == ext {
			return true
		}
	}
	return false
}

func (c *homeClient) get(ctx context.Context, s *homeSession, p string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.address(p), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+s.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, refusal(resp.StatusCode, "file")
	}
	return resp, nil
}

// put writes a file and returns the home's mark of what it now holds. The
// conditions are the page's: If-Match to replace only what it read,
// If-None-Match to write only where nothing is.
func (c *homeClient) put(ctx context.Context, s *homeSession, p string, body io.Reader, length int64, ifMatch, ifNoneMatch string) (string, error) {
	if length < 0 {
		// A home wants the length; the page always sends one.
		buf, err := io.ReadAll(body)
		if err != nil {
			return "", &homeError{http.StatusRequestEntityTooLarge, "the file is too large"}
		}
		body, length = bytes.NewReader(buf), int64(len(buf))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, s.address(p), body)
	if err != nil {
		return "", err
	}
	req.ContentLength = length
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Content-Type", "application/octet-stream")
	if ifMatch != "" {
		req.Header.Set("If-Match", ifMatch)
	}
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	switch resp.StatusCode {
	case http.StatusOK, http.StatusCreated, http.StatusNoContent:
		return resp.Header.Get("ETag"), nil
	case http.StatusPreconditionFailed:
		if ifNoneMatch != "" {
			return "", &homeError{http.StatusPreconditionFailed, "a file of that name is there already"}
		}
		return "", &homeError{http.StatusPreconditionFailed, "the file was changed elsewhere since it was opened"}
	}
	return "", refusal(resp.StatusCode, "file")
}

// refusal turns the home's answer into one for the page.
func refusal(status int, what string) error {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return &homeError{http.StatusForbidden, "you may not use this " + what}
	case http.StatusNotFound, http.StatusConflict:
		return &homeError{http.StatusNotFound, "no such " + what}
	case http.StatusLocked:
		return &homeError{http.StatusLocked, "the " + what + " is locked"}
	case http.StatusInsufficientStorage:
		return &homeError{http.StatusInsufficientStorage, "the place for files is full"}
	case http.StatusRequestEntityTooLarge:
		return &homeError{http.StatusRequestEntityTooLarge, "the file is too large"}
	}
	return fmt.Errorf("the home answered %d for a %s", status, what)
}

// pathOf is the decoded path of an address or of a listing's href, which a
// home gives with or without its host.
func pathOf(href string) string {
	u, err := url.Parse(href)
	if err != nil {
		return href
	}
	return u.Path
}

func decoded(href string) string { return pathOf(strings.TrimSpace(href)) }
