#!/bin/sh
# Fills in the form of Super Productivity's CalDAV integration in advance:
# the server is this address's CalDAV relay (/caldav/), and the user name and
# password are placeholders, because the tenant's edge signs the person in and
# the relay asks the calendar home as them. The person adds "CalDAV" and names
# the calendar; nothing else is asked.
#
# Upstream reads no default settings for its integrations, only for its sync
# (gentian-apps#370 asks for them). Until then the compiled defaults
# (DEFAULT_CALDAV_CFG) are changed here, and the service worker's record of
# the file's hash with them. The build fails when the pattern is not found
# exactly once, so a new upstream release cannot drop the change unnoticed.
set -eu
site=${1:-/site}
from='isEnabled:!1,caldavUrl:null,resourceName:null,username:null,password:null,'
to='isEnabled:!1,caldavUrl:location.origin+"/caldav/",resourceName:null,username:"signed-in",password:"signed-in",'

files=$(grep -lF "$from" "$site"/*.js || true)
if [ "$(printf '%s\n' "$files" | grep -c .)" -ne 1 ]; then
  echo "prefill-caldav: expected the CalDAV defaults in exactly one file, found: ${files:-none}" >&2
  exit 1
fi
if [ "$(grep -oF "$from" "$files" | wc -l)" -ne 1 ]; then
  echo "prefill-caldav: the CalDAV defaults appear more than once in $files" >&2
  exit 1
fi
old=$(sha1sum "$files" | cut -d' ' -f1)
sed -i "s|$(printf '%s' "$from" | sed 's/[!.]/\\&/g')|$to|" "$files"
grep -qF "$to" "$files"
new=$(sha1sum "$files" | cut -d' ' -f1)

# The service worker keeps each file's hash and refuses a file that does not
# match it.
if [ -f "$site/ngsw.json" ]; then
  name="/$(basename "$files")"
  grep -qF "\"$name\": \"$old\"" "$site/ngsw.json" || {
    echo "prefill-caldav: ngsw.json has no hash $old for $name" >&2
    exit 1
  }
  sed -i "s|\"$name\": \"$old\"|\"$name\": \"$new\"|" "$site/ngsw.json"
fi
echo "prefill-caldav: $files"
