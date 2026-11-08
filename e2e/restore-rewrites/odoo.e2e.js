'use strict';

// Odoo (the chart's own image and odoo.conf) imported into another cluster
// under another domain, its database under another name: the data volume's
// filestore/<database> still has the old name, and the database names the
// old domain. The profile's post-restore commands run as the platform runs
// them, once Odoo is resumed, and afterwards Odoo reads its stored files from
// the database's new name and keeps no address on the old domain.
//
//   e2e/restore-rewrites/run.sh odoo

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const r = require('./lib/restore');

const PROFILE = r.profileOf('profiles/odoo/base/base-ce');
const CHART = path.join(r.REPO, 'charts', 'odoo');
const CHART_VALUES = r.YAML.parse(fs.readFileSync(path.join(CHART, 'values.yaml'), 'utf8'));
const IMAGE = `${CHART_VALUES.image.repository}@${CHART_VALUES.image.digest}`;

const OLD = { domain: 'old.e2e.test', db: { name: 'acme_odoo_old', user: 'acme_odoo_old', password: 'old-db-pw-0123456789' } };
const NEW = { domain: 'new.e2e.test', db: { name: 'acme_odoo', user: 'acme_odoo', password: 'new-db-pw-0123456789' } };
const CONTENT = 'a file Odoo keeps in its filestore';

const names = { pg: `${r.NETWORK}-pg-odoo`, old: `${r.NETWORK}-odoo-old`, app: `${r.NETWORK}-odoo`, volume: `${r.NETWORK}-odoo-data` };
let scratch;
let storeFname;

// odoo.conf as the chart renders it, which is where data_dir is read from.
function renderConf(dir) {
    const rendered = r.YAML.parseAllDocuments(require('node:child_process').execFileSync('helm',
        ['template', 'odoo', CHART, '--show-only', 'templates/configmap.yaml'], { encoding: 'utf8' }));
    const cm = rendered.map((d) => d.toJSON()).find((d) => d && d.kind === 'ConfigMap');
    fs.writeFileSync(path.join(dir, 'odoo.conf'), cm.data['odoo.conf'], { mode: 0o644 });
}

function startOdooContainer(name, db) {
    r.tryDocker('rm', '-f', name);
    r.docker('run', '-d', '--name', name, '--network', r.NETWORK, '-v', `${names.volume}:/opt/odoo/data`,
        '-v', `${scratch}/odoo.conf:/etc/odoo/odoo.conf:ro`,
        '-e', `DB_HOST=${names.pg}`, '-e', 'DB_PORT=5432', '-e', `DB_USER=${db.user}`, '-e', `DB_PASSWORD=${db.password}`, '-e', `DB_NAME=${db.name}`,
        '--entrypoint', 'sleep', IMAGE, 'infinity');
    // Where the chart's git-sync puts the modules it syncs.
    r.docker('exec', '-u', '0', name, 'sh', '-c', 'mkdir -p /opt/odoo/custom-addons/default/current && chown -R odoo /opt/odoo/data');
}

const BIN = 'python3 /opt/odoo/src/odoo/odoo-bin';
const ARGS = '-d "$DB_NAME" --db_host="$DB_HOST" --db_port="$DB_PORT" --db_user="$DB_USER" --config=/etc/odoo/odoo.conf';
const ODOO = `${BIN} ${ARGS}`;

function shell(container, code) {
    return r.dockerIn(code, 'exec', '-i', container, 'sh', '-c',
        `PGPASSWORD="$DB_PASSWORD" ${BIN} shell ${ARGS} --no-http --shell-interface=python --log-level=error`);
}

before(async () => {
    r.cleanUp([names.old, names.app, names.pg], [names.volume]);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-e2e-odoo-'));
    fs.chmodSync(scratch, 0o755);
    renderConf(scratch);
    await r.startPostgres(names.pg);
    r.createDatabase(names.pg, OLD.db);

    // Where the data was written.
    startOdooContainer(names.old, OLD.db);
    r.docker('exec', names.old, 'sh', '-c', `PGPASSWORD="$DB_PASSWORD" ${ODOO} -i base,auth_oauth,mail --without-demo=all --stop-after-init --log-level=warn`);
    storeFname = shell(names.old, `
icp = env["ir.config_parameter"].sudo()
icp.set_param("web.base.url", "https://erp.${OLD.domain}")
env["auth.oauth.provider"].sudo().create({"name": "Keycloak", "client_id": "odoo-cb", "enabled": True, "body": "Keycloak",
    "auth_endpoint": "https://id.${OLD.domain}/auth/realms/acme/protocol/openid-connect/auth",
    "validation_endpoint": "http://gentian-idp-keycloak-keycloakx-http.kernel-authentication.svc.cluster.local:8080/auth/realms/acme/protocol/openid-connect/userinfo"})
env["mail.alias.domain"].sudo().create({"name": "${OLD.domain}"})
a = env["ir.attachment"].sudo().create({"name": "e2e.txt", "raw": b"${CONTENT}"})
env.cr.commit()
print("STORE=" + a.store_fname)
`).split('\n').find((l) => l.startsWith('STORE=')).slice(6);
    r.docker('rm', '-f', names.old);

    // Where it is put back: the database the platform made here, and Odoo
    // resumed with this cluster's values before the commands run.
    r.moveDatabase(names.pg, OLD.db, NEW.db);
    startOdooContainer(names.app, NEW.db);
    r.docker('exec', '-d', names.app, 'sh', '-c', `PGPASSWORD="$DB_PASSWORD" exec ${ODOO} >/tmp/odoo.log 2>&1`);
});

after(() => {
    r.cleanUp([names.old, names.app, names.pg], [names.volume]);
    if (scratch && !process.env.E2E_KEEP) fs.rmSync(scratch, { recursive: true, force: true });
});

const ENV = r.restoreEnv({
    app: 'odoo-base-ce',
    source: { tenant: 'acme', domain: OLD.domain, platformVersion: '0.5', cluster: 'zrh-1' },
    target: { tenant: 'acme', domain: NEW.domain, cluster: 'gva-2' },
    databases: [[OLD.db.name, NEW.db.name]],
    volumes: [['odoo-data', 'odoo-data']],
});

test('the post-restore commands run as the platform runs them, and again without changing anything', () => {
    const first = r.runRestore(PROFILE, names.app, ENV);
    assert.match(first, new RegExp(`filestore of ${OLD.db.name} is now the filestore of ${NEW.db.name}`));
    assert.match(first, /ir\.config_parameter web\.base\.url now names/);
    const again = r.runRestore(PROFILE, names.app, ENV);
    assert.doesNotMatch(again, /now names|is now the filestore/);
    assert.ok(!first.includes(NEW.db.password) && !again.includes(NEW.db.password), 'a credential was printed');
});

test('a bundle that does not say where it was written is restored without failing', () => {
    r.runRestore(PROFILE, names.app, r.restoreEnv({ app: 'odoo-base-ce', target: { tenant: 'acme', domain: NEW.domain } }));
});

test('the filestore is the database\'s new name, and Odoo reads its stored files from it', () => {
    assert.equal(r.docker('exec', names.app, 'ls', '/opt/odoo/data/filestore'), NEW.db.name);
    const out = shell(names.app, `print("RAW=" + env["ir.attachment"].sudo().search([("name", "=", "e2e.txt")]).raw.decode())`);
    assert.ok(out.includes(`RAW=${CONTENT}`), out);
    r.docker('exec', names.app, 'test', '-f', `/opt/odoo/data/filestore/${NEW.db.name}/${storeFname}`);
});

test('nothing in the database names the old domain', () => {
    const out = shell(names.app, `
import json
print("JSON=" + json.dumps({
    "base": env["ir.config_parameter"].sudo().get_param("web.base.url"),
    "auth": env["auth.oauth.provider"].sudo().search([("name", "=", "Keycloak")]).auth_endpoint,
    "alias": env["mail.alias.domain"].sudo().search([]).mapped("name"),
}))
`);
    const got = JSON.parse(out.split('\n').find((l) => l.startsWith('JSON=')).slice(5));
    assert.equal(got.base, `https://erp.${NEW.domain}`);
    assert.equal(got.auth, `https://id.${NEW.domain}/auth/realms/acme/protocol/openid-connect/auth`);
    assert.deepEqual(got.alias, [NEW.domain]);
});
