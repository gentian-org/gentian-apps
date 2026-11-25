// SPDX-License-Identifier: MIT

// Command host serves a browser app's build and, where the tenant has a home
// for files, lets the app reach it as the signed-in person. It does so in one
// of two ways, chosen by CRAFT_MODE:
//
//   - "frame" (the Crafting Apps): a page that frames the app and four file
//     calls, by which the app opens and saves where the person chooses;
//   - "relay": the app served as it is, and a WebDAV relay under /webdav/
//     into one folder of the person's files, for an app that syncs with a
//     WebDAV server of its own accord; and, where the tenant has a home
//     for calendars, a CalDAV relay under /caldav/ into the person's
//     calendars, for an app that reads and writes a CalDAV server;
//   - "jmap": the app served as it is, told the person's account at the
//     tenant's JMAP mail server and given the person's token to reach it
//     with, for an app that reads that server itself (jmap.go).
//
// It holds nothing of anybody: the person's token arrives with each request
// from the tenant's edge, is exchanged at the realm for one valid at the
// home, and is used for that request. Without a home the app is served as
// upstream ships it.
package main

import (
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	cfg := configFromEnv()
	srv := &http.Server{
		Addr:              cfg.listen,
		Handler:           newServer(cfg),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	log.Printf("serving %s from %s on %s", cfg.app, cfg.site, cfg.listen)
	if err := srv.ListenAndServe(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

// config is what the pod is told.
type config struct {
	// app is the app's name as its messages carry it ("wordcraft").
	app string
	// title is the name a person reads.
	title string
	// site is the directory of the app's browser build.
	site   string
	listen string
	// home is the address the tenant's file home answers WebDAV at, empty
	// while the tenant grants none.
	home string
	// homeScope is the scope the realm issues the home's token under, empty
	// while the tenant grants none. The platform sets it with the address.
	homeScope string
	// vouching is the directory the platform's Secret is mounted at: the
	// client to ask the realm with.
	vouching string
	// extensions are the file name endings the app opens.
	extensions []string
	// maxBytes bounds one file.
	maxBytes int64
	// mode is "frame" or "relay" (see the package comment).
	mode string
	// davFolder is, in relay mode, the folder of the person's files the
	// relay reaches, and nothing beside it.
	davFolder string
	// settingsPath is, in relay mode, the address the app reads its default
	// settings from, and settingsTemplate the file they are made from:
	// {{origin}}, {{folder}} and {{name}} are put in. Empty serves none.
	settingsPath     string
	settingsTemplate string
	// calendarHome is, in relay mode, the address the tenant's calendar
	// home answers CalDAV at, and calendarScope the scope its token is
	// issued under; both empty while the tenant grants none.
	calendarHome  string
	calendarScope string
	// jmapSession is, in jmap mode, the address of the mail server's JMAP
	// session resource, and jmapIMAPHost the server's IMAP host, from which
	// that address is made when none is given; both empty while the
	// tenant's mail is on no server outside the cluster.
	jmapSession  string
	jmapIMAPHost string
}

func configFromEnv() config {
	get := func(key, fallback string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		return fallback
	}
	return config{
		app:        get("CRAFT_APP", "wordcraft"),
		title:      get("CRAFT_TITLE", "WordCraft"),
		site:       get("CRAFT_SITE", "/site"),
		listen:     get("CRAFT_LISTEN", ":8080"),
		home:       os.Getenv("CRAFT_HOME_URL"),
		homeScope:  os.Getenv("CRAFT_HOME_SCOPE"),
		vouching:   get("CRAFT_VOUCHING_DIR", "/var/run/gentian/vouching"),
		extensions: splitList(get("CRAFT_EXTENSIONS", ".docx,.odt,.md,.txt,.rtf,.html")),
		maxBytes:   256 << 20,
		mode:       get("CRAFT_MODE", "frame"),
		davFolder:  get("CRAFT_DAV_FOLDER", "Apps"),

		settingsPath:     os.Getenv("CRAFT_SETTINGS_PATH"),
		settingsTemplate: os.Getenv("CRAFT_SETTINGS_TEMPLATE"),
		calendarHome:     os.Getenv("CRAFT_CALENDAR_URL"),
		calendarScope:    os.Getenv("CRAFT_CALENDAR_SCOPE"),
		jmapSession:      os.Getenv("CRAFT_JMAP_SESSION"),
		jmapIMAPHost:     os.Getenv("CRAFT_JMAP_IMAP_HOST"),
	}
}
