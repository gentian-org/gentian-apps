'use strict';

// Mathesar (the chart's own image, command and security context) imported
// into another cluster under another domain. Its own database keeps an entry
// for each database it connects to: the server's host and port, the
// database's name, the role and that role's password. The database it made
// itself comes back under the name the restore gives it, owned by this
// cluster's role, which has a new password, on a server reached by another
// name; Mathesar then cannot open it. The profile's post-restore commands run
// as the platform runs them, and afterwards Mathesar opens it again, while a
// connection to another server is as it was.
//
//   e2e/restore-rewrites/run.sh mathesar

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const r = require('./lib/restore');

const PROFILE = r.profileOf('profiles/mathesar/mathesar-ce');
const CHART = path.join(r.REPO, 'charts', 'mathesar');

// The Deployment as the chart renders it: image, command, user.
const DEPLOYMENT = r.YAML.parseAllDocuments(execFileSync('helm',
    ['template', 'mathesar-ce', CHART, '--show-only', 'templates/deployment.yaml'], { encoding: 'utf8' }))
    .map((d) => d.toJSON()).find((d) => d && d.kind === 'Deployment');
const CONTAINER = DEPLOYMENT.spec.template.spec.containers[0];
const UID = String(DEPLOYMENT.spec.template.spec.securityContext.runAsUser);
const GID = String(DEPLOYMENT.spec.template.spec.securityContext.runAsGroup);

const names = { pg: `${r.NETWORK}-pg-mathesar`, old: `${r.NETWORK}-mathesar-old`, app: `${r.NETWORK}-mathesar`, volume: `${r.NETWORK}-mathesar-media` };

// One PostgreSQL server, called by another name on each cluster.
const OLD = {
    domain: 'old.e2e.test', host: 'postgres.zrh-1.e2e',
    db: { name: 'acme_mathesar_old', user: 'acme_mathesar_old', password: 'old-db-pw-0123456789' },
};
const NEW = {
    domain: 'new.e2e.test', host: 'postgres.gva-2.e2e',
    db: { name: 'acme_mathesar', user: 'acme_mathesar', password: 'new-db-pw-0123456789' },
};
// The database Mathesar made itself, and the name a restore into another
// database gives it (gentian-os, PostgresOwnedRestoreJob).
const MADE = { old: `${OLD.db.name}_reports`, new: `${NEW.db.name}_reports` };
// The app's own secrets come back with the bundle.
const SECRET_KEY = 'e2e-secret-key-0123456789abcdefghijklmnopqrstuvwxyz';
const ADMIN = { user: 'gentian-bootstrap-admin', password: 'e2e-admin-pw-0123456789' };
const ELSEWHERE = { host: 'pg.elsewhere.example', port: 5432, db: 'theirs', role: 'someone', password: 'elsewhere-pw-0123456789' };
const SCHEMA = 'Library Management';

function start(name, at, { serve }) {
    r.tryDocker('rm', '-f', name);
    const env = {
        DJANGO_SETTINGS_MODULE: 'config.settings.production',
        ALLOWED_HOSTS: `.${at.domain},mathesar-ce,.svc.cluster.local`,
        DEBUG: 'false', MATHESAR_DJANGO_ADMIN_ENABLED: 'false', WEB_CONCURRENCY: '1', REQUIRE_SSO_LOGIN: 'false',
        POSTGRES_DB: at.db.name, POSTGRES_HOST: at.host, POSTGRES_PORT: '5432',
        POSTGRES_USER: at.db.user, POSTGRES_PASSWORD: at.db.password, SECRET_KEY,
    };
    r.docker('run', '-d', '--name', name, '--network', r.NETWORK, '--network-alias', 'mathesar-ce',
        '-u', `${UID}:${GID}`, '--read-only',
        '--tmpfs', `/tmp:uid=${UID}`, '--tmpfs', `/code/static:uid=${UID}`,
        '-v', `${names.volume}:/code/.media`,
        ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        ...(serve ? [] : ['--entrypoint', 'sleep']),
        `${CONTAINER.image}`, ...(serve ? CONTAINER.command : ['infinity']));
}

// Mathesar's Django, in the container, with the code on stdin.
function shell(container, code) {
    return r.dockerIn(code, 'exec', '-i', container, 'python3', 'manage.py', 'shell');
}

function json(out) {
    return JSON.parse(out.split('\n').find((l) => l.startsWith('JSON=')).slice(5));
}

// Mathesar's own API, as the platform's sync job calls it.
function rpc(container, method, params) {
    const out = r.docker('exec', container, 'python3', '-c', `import base64, json, sys, urllib.request
body = json.dumps({"jsonrpc": "2.0", "method": sys.argv[1], "params": json.loads(sys.argv[2]), "id": 1}).encode()
token = base64.b64encode(b"${ADMIN.user}:${ADMIN.password}").decode()
req = urllib.request.Request("http://127.0.0.1:8000/api/rpc/v0/", data=body, headers={
    "Content-Type": "application/json", "Authorization": "Basic " + token, "Host": "mathesar-ce"})
print(urllib.request.urlopen(req, timeout=60).read().decode())`, method, JSON.stringify(params || {}));
    const reply = JSON.parse(out);
    if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
    return reply.result;
}

function reportsDatabase(container) {
    const db = rpc(container, 'databases.configured.list').find((d) => d.name === MADE.new || d.name === MADE.old);
    assert.ok(db, 'Mathesar no longer lists the database it made');
    return db;
}

// What Mathesar shows of the database it made: its tables.
function tablesOf(container) {
    const db = reportsDatabase(container);
    const schema = rpc(container, 'schemas.list', { database_id: db.id }).find((s) => s.name === SCHEMA);
    assert.ok(schema, `no schema ${SCHEMA}`);
    return rpc(container, 'tables.list', { schema_oid: schema.oid, database_id: db.id }).map((t) => t.name).sort();
}

let tablesBefore;

before(async () => {
    r.cleanUp([names.old, names.app, names.pg], [names.volume]);
    await r.startPostgres(names.pg, { aliases: [OLD.host, NEW.host] });
    r.createDatabase(names.pg, OLD.db);
    // What the platform grants a role whose app creates databases.
    r.psql(names.pg, `ALTER ROLE "${OLD.db.user}" CREATEDB`);
    r.docker('volume', 'create', names.volume);
    r.docker('run', '--rm', '-u', '0', '-v', `${names.volume}:/m`, '--entrypoint', 'chown', CONTAINER.image, `${UID}:${GID}`, '/m');

    // Where the data was written: served, the administrator the profile
    // makes, a database made in Mathesar with sample data, a connection to a
    // server of someone else's, a role on the platform's server no restore
    // brings back, and forms that redirect on the old domain and elsewhere.
    start(names.old, OLD, { serve: true });
    await r.waitFor('Mathesar', () => r.docker('exec', names.old, 'curl', '-fs', '-H', 'Host: mathesar-ce', 'http://127.0.0.1:8000/healthz/ready/') !== null, 300);
    shell(names.old, `
import uuid
from django.contrib.auth import get_user_model
from mathesar.models.base import Server, Database, ConfiguredRole, UserDatabaseRoleMap, Form
from mathesar.utils.permissions import set_up_new_database_for_user_on_internal_server
u = get_user_model().objects.create_superuser(username="${ADMIN.user}", email="admin@internal.invalid", password="${ADMIN.password}")
m = set_up_new_database_for_user_on_internal_server("${MADE.old}", "Reports", u, sample_data=["library_management"])
ConfiguredRole.objects.create(name="analyst", server=m.server, password="analyst-pw-0123456789")
s = Server.objects.create(host="${ELSEWHERE.host}", port=${ELSEWHERE.port})
d = Database.objects.create(name="${ELSEWHERE.db}", server=s)
cr = ConfiguredRole.objects.create(name="${ELSEWHERE.role}", server=s, password="${ELSEWHERE.password}")
UserDatabaseRoleMap.objects.create(user=u, database=d, configured_role=cr, server=s)
for n, url in (("ours", "https://data.${OLD.domain}/thanks/"), ("theirs", "https://example.org/${OLD.domain}/")):
    Form.objects.create(token=uuid.uuid4(), name=n, version=1, database=m.database, server=m.server, schema_oid=0,
                        base_table_oid=0, header_title={}, submit_redirect_url=url)
`);
    tablesBefore = tablesOf(names.old);
    assert.ok(tablesBefore.length > 0, 'the sample data has no tables');
    r.docker('rm', '-f', names.old);

    // Where it is put back: Mathesar's own database and the one it made,
    // each under this cluster's name and owned by this cluster's role, the
    // old role gone; Mathesar resumed with this cluster's values before the
    // commands run.
    r.moveDatabase(names.pg, OLD.db, NEW.db);
    r.psql(names.pg, `ALTER ROLE "${NEW.db.user}" CREATEDB`, `CREATE DATABASE "${MADE.new}" OWNER "${NEW.db.user}"`);
    r.docker('exec', names.pg, 'sh', '-c',
        `pg_dump -U postgres -O -x "${MADE.old}" | PGPASSWORD='${NEW.db.password}' psql -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "${NEW.db.user}" "${MADE.new}"`);
    start(names.app, NEW, { serve: true });
    await r.waitFor('Mathesar', () => r.docker('exec', names.app, 'curl', '-fs', '-H', 'Host: mathesar-ce', 'http://127.0.0.1:8000/healthz/ready/') !== null, 300);
});

after(() => r.cleanUp([names.old, names.app, names.pg], [names.volume]));

const ENV = r.restoreEnv({
    app: 'mathesar-ce',
    source: { tenant: 'acme', domain: OLD.domain, kernelDomain: 'zrh-1.e2e', platformVersion: '0.5', cluster: 'zrh-1' },
    target: { tenant: 'acme', domain: NEW.domain, kernelDomain: 'gva-2.e2e', cluster: 'gva-2' },
    databases: [[OLD.db.name, NEW.db.name], [MADE.old, MADE.new]],
    roles: [[OLD.db.user, NEW.db.user]],
    volumes: [['mathesar-ce-media', 'mathesar-ce-media']],
});

const SECRETS = [OLD.db.password, NEW.db.password, ELSEWHERE.password, 'analyst-pw-0123456789'];

test('started with this cluster\'s values, it cannot open the database it made', () => {
    assert.throws(() => tablesOf(names.app), /OperationalError/);
});

test('the post-restore commands run as the platform runs them, and again without changing anything', () => {
    const first = r.runRestore(PROFILE, names.app, ENV, { user: UID });
    assert.match(first, new RegExp(`connections to ${OLD.host}:5432 now go to ${NEW.host}:5432`));
    assert.match(first, new RegExp(`database ${MADE.old} is now ${MADE.new}`));
    assert.match(first, new RegExp(`role ${OLD.db.user} is now ${NEW.db.user}`));
    assert.match(first, new RegExp(`role ${NEW.db.user} connects with the password this pod is given`));
    assert.match(first, /role analyst is not on this server/);
    assert.match(first, /form \d+ redirects to new\.e2e\.test/);
    const again = r.runRestore(PROFILE, names.app, ENV, { user: UID });
    assert.doesNotMatch(again, /now go to|is now|connects with|redirects to/);
    for (const s of SECRETS) assert.ok(!first.includes(s) && !again.includes(s), 'a credential was printed');
    // Rolled, as the platform rolls it once the commands have run.
    r.docker('restart', names.app);
});

test('a bundle that does not say where it was written is restored without failing', () => {
    const out = r.runRestore(PROFILE, names.app, r.restoreEnv({ app: 'mathesar-ce', target: { tenant: 'acme', domain: NEW.domain } }), { user: UID });
    assert.doesNotMatch(out, /now go to|is now|connects with|redirects to/);
});

test('Mathesar opens the database it made, under its name here, as before', async () => {
    await r.waitFor('Mathesar', () => r.docker('exec', names.app, 'curl', '-fs', '-H', 'Host: mathesar-ce', 'http://127.0.0.1:8000/healthz/ready/') !== null, 300);
    assert.equal(reportsDatabase(names.app).name, MADE.new);
    assert.deepEqual(tablesOf(names.app), tablesBefore);
});

test('a connection to another server, and a form redirecting elsewhere, are as they were', () => {
    const got = json(shell(names.app, `
import json
from mathesar.models.base import Server, ConfiguredRole, Form
s = Server.objects.get(host="${ELSEWHERE.host}")
print("JSON=" + json.dumps({
    "servers": sorted("%s:%s" % (x.host, x.port) for x in Server.objects.all()),
    "dbs": [d.name for d in s.databases.all()],
    "role": ConfiguredRole.objects.get(server=s).name,
    "pw": ConfiguredRole.objects.get(server=s).password == "${ELSEWHERE.password}",
    "forms": dict(Form.objects.values_list("name", "submit_redirect_url")),
}))
`));
    assert.deepEqual(got.servers, [`${ELSEWHERE.host}:${ELSEWHERE.port}`, `${NEW.host}:5432`]);
    assert.deepEqual(got.dbs, [ELSEWHERE.db]);
    assert.equal(got.role, ELSEWHERE.role);
    assert.equal(got.pw, true);
    assert.deepEqual(got.forms, { ours: `https://data.${NEW.domain}/thanks/`, theirs: `https://example.org/${OLD.domain}/` });
});
