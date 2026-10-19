#!/bin/bash
# Prepares the bench and the site before any Frappe process of the pod starts.
# Runs on every start and changes only what differs; the first start creates
# the site.
set -euo pipefail
umask 0002

BENCH=/home/frappe/frappe-bench
SITES="${BENCH}/sites"
SITE="${FRAPPE_SITE:?FRAPPE_SITE is not set}"
PYTHON="${BENCH}/env/bin/python"

say() { echo "erpnext-configure: $*"; }

cd "${BENCH}"

# The sites directory is the volume, so what the image keeps there is hidden by
# it. The built assets are linked in, as the image's own entrypoint does, and
# the list of the image's apps is written again: after an upgrade it is the new
# image's.
rm -rf "${SITES}/assets"
ln -s "${BENCH}/assets" "${SITES}/assets"
ls -1 apps > "${SITES}/apps.txt"

# The bench's configuration: the pod's own Redis and socket server. Written whole.
"${PYTHON}" - <<'PY'
import json, os
conf = {
    "redis_cache": "redis://127.0.0.1:%s" % os.environ["REDIS_CACHE_PORT"],
    "redis_queue": "redis://127.0.0.1:%s" % os.environ["REDIS_QUEUE_PORT"],
    "redis_socketio": "redis://127.0.0.1:%s" % os.environ["REDIS_QUEUE_PORT"],
    "socketio_port": 9000,
    "webserver_port": 8000,
}
path = "/home/frappe/frappe-bench/sites/common_site_config.json"
with open(path + ".tmp", "w") as f:
    json.dump(conf, f, indent=1, sort_keys=True)
os.replace(path + ".tmp", path)
PY

# One release serves one site. A site found under another name was written on
# another domain and brought here by a restore: it is this site, renamed.
if [ ! -f "${SITES}/${SITE}/site_config.json" ]; then
  others=()
  for conf in "${SITES}"/*/site_config.json; do
    [ -f "${conf}" ] || continue
    others+=("$(basename "$(dirname "${conf}")")")
  done
  if [ "${#others[@]}" -gt 1 ]; then
    say "the volume holds the sites ${others[*]}; this release serves one, ${SITE}, and cannot tell which it is" >&2
    exit 1
  fi
  if [ "${#others[@]}" -eq 1 ]; then
    rm -rf "${SITES:?}/${SITE}"
    mv "${SITES}/${others[0]}" "${SITES}/${SITE}"
    say "site ${others[0]} is now ${SITE}"
  fi
fi

marker="${SITES}/${SITE}/gentian-image-versions"
# Beside the site, not in it: bench new-site removes the site's directory when it fails.
creating="${SITES}/.gentian-creating-${SITE}"
new_site=false
incomplete=false
if [ -f "${creating}" ]; then
  # A start that was creating the site stopped before it finished. What it
  # left in the database is its own, and is cleared before it starts again.
  new_site=true
  incomplete=true
elif [ ! -f "${SITES}/${SITE}/site_config.json" ]; then
  new_site=true
fi

# The site's configuration: where its database is and as whom, its address, and
# its outgoing mail, from this pod's values. Everything else in the file is the
# site's own and is kept, the encryption key above all: it is what the
# passwords stored in the database were encrypted with.
mkdir -p "${SITES}/${SITE}"
NEW_SITE="${new_site}" "${PYTHON}" - <<'PY'
import json, os
site = os.environ["FRAPPE_SITE"]
path = "/home/frappe/frappe-bench/sites/%s/site_config.json" % site
conf = {}
if os.path.exists(path):
    with open(path) as f:
        conf = json.load(f)
conf.update({
    "db_type": "mariadb",
    "db_host": os.environ["DB_HOST"],
    "db_port": int(os.environ["DB_PORT"]),
    "db_name": os.environ["DB_NAME"],
    "db_user": os.environ["DB_USER"],
    "db_password": os.environ["DB_PASSWORD"],
    "host_name": "https://" + site,
})
mail = {
    "mail_server": os.environ.get("SMTP_HOST", ""),
    "mail_port": int(os.environ.get("SMTP_PORT") or 0) or None,
    "mail_login": os.environ.get("SMTP_USER", ""),
    "mail_password": os.environ.get("SMTP_PASSWORD", ""),
    "use_tls": 1 if os.environ.get("SMTP_USE_TLS") == "true" else 0,
    "auto_email_id": os.environ.get("SMTP_FROM", ""),
    "email_sender_name": os.environ.get("SMTP_SENDER_NAME", ""),
}
for key, value in mail.items():
    if mail["mail_server"] and value not in ("", None):
        conf[key] = value
    else:
        conf.pop(key, None)
if os.environ.get("NEW_SITE") == "true":
    # Read by bench new-site below and removed again once the site exists.
    conf["admin_password"] = os.environ["ADMIN_PASSWORD"]
with open(path + ".tmp", "w") as f:
    json.dump(conf, f, indent=1, sort_keys=True)
os.chmod(path + ".tmp", 0o660)
os.replace(path + ".tmp", path)
PY

versions="$("${PYTHON}" -c 'import frappe, erpnext; print("frappe %s erpnext %s" % (frappe.__version__, erpnext.__version__))')"

if [ "${new_site}" = true ]; then
  # An empty database only. A database that already holds a site while the
  # volume holds none is a site whose volume was lost or not restored, and
  # bench new-site would overwrite it. The tables of a creation that did not
  # finish are the one exception: they are dropped.
  if ! INCOMPLETE="${incomplete}" "${PYTHON}" - <<'PY'
import os, sys
import pymysql
db = os.environ["DB_NAME"]
conn = pymysql.connect(host=os.environ["DB_HOST"], port=int(os.environ["DB_PORT"]),
                       user=os.environ["DB_USER"], password=os.environ["DB_PASSWORD"],
                       database=db, connect_timeout=10)
with conn.cursor() as c:
    c.execute("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = %s", (db,))
    tables = c.fetchall()
    if not tables:
        sys.exit(0)
    if os.environ.get("INCOMPLETE") != "true":
        c.execute("SHOW TABLES LIKE 'tabDefaultValue'")
        sys.exit(1 if c.fetchone() else 0)
    c.execute("SET FOREIGN_KEY_CHECKS = 0")
    for name, kind in tables:
        c.execute(("DROP VIEW IF EXISTS `%s`" if kind == "VIEW" else "DROP TABLE IF EXISTS `%s`") % name.replace("`", "``"))
    print("erpnext-configure: dropped the %d tables of the creation that did not finish" % len(tables), flush=True)
PY
  then
    rm -f "${SITES}/${SITE}/site_config.json"
    say "database ${DB_NAME} already holds a Frappe site, and the volume holds none; it is left as it is." >&2
    say "Restore the volume that belongs to it, or empty the database to start a new site." >&2
    exit 1
  fi
  touch "${creating}"
  say "creating site ${SITE} and installing ERPNext into ${DB_NAME}; this takes several minutes"
  # --force: the site's directory exists, holding the configuration above.
  # --no-setup-db: the database and its user are the platform's.
  bench new-site "${SITE}" --force --no-setup-db --db-name "${DB_NAME}" --install-app erpnext
  bench --site "${SITE}" enable-scheduler
  "${PYTHON}" - <<'PY'
import json, os
path = "/home/frappe/frappe-bench/sites/%s/site_config.json" % os.environ["FRAPPE_SITE"]
with open(path) as f:
    conf = json.load(f)
conf.pop("admin_password", None)
with open(path + ".tmp", "w") as f:
    json.dump(conf, f, indent=1, sort_keys=True)
os.replace(path + ".tmp", path)
PY
  echo "${versions}" > "${marker}"
  rm -f "${creating}"
  say "site ${SITE} created (${versions})"
elif [ "$(cat "${marker}" 2>/dev/null || true)" != "${versions}" ]; then
  say "the image is ${versions}, the site was last migrated under $(cat "${marker}" 2>/dev/null || echo 'an unrecorded version'); migrating"
  bench --site "${SITE}" migrate
  echo "${versions}" > "${marker}"
fi

# Sign-in and the settings that go with it, from this pod's values.
# From the sites directory, as bench runs Frappe: Frappe finds the bench from there.
(cd "${SITES}" && "${PYTHON}" /gentian/configure.py)
say "site ${SITE} is configured"
