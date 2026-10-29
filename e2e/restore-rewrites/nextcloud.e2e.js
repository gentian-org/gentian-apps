'use strict';

// Nextcloud (the catalog's own image) imported into another cluster under
// another domain: its volume and database come back, the database under
// another name and owned by another role, the sign-in client and every IMAP
// credential made new. The profile's post-restore commands run as the
// platform runs them, in maintenance mode, and afterwards Nextcloud reaches
// its database, answers at the new address and no longer at the old one,
// and holds the new sign-in secret and IMAP credentials -- and the mail
// account a person added themselves is as it was.
//
//   e2e/restore-rewrites/run.sh nextcloud

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const r = require('./lib/restore');

const PROFILE = r.profileOf('profiles/nextcloud/base/base-ce');
const VALUES = PROFILE.spec.package.extraValues;
const IMAGE = process.env.E2E_NEXTCLOUD_IMAGE || `${VALUES.image.registry}/${VALUES.image.repository}:${VALUES.image.tag}`;
const PORT = VALUES.nextcloud.containerPort;
const QUIESCE = PROFILE.spec.backup.quiesce;

const TENANT = 'acme';
const OLD = { domain: 'old.e2e.test', db: { name: 'acme_nextcloud_old', user: 'acme_nextcloud_old', password: 'old-db-pw-0123456789' } };
const NEW = { domain: 'new.e2e.test', db: { name: 'acme_nextcloud', user: 'acme_nextcloud', password: 'new-db-pw-0123456789' } };
const DISCOVERY = `http://gentian-idp-keycloak-keycloakx-http.kernel-authentication.svc.cluster.local:8080/auth/realms/${TENANT}/.well-known/openid-configuration`;
const SECRETS = { oidcOld: 'old-client-secret-0123456789', oidcNew: 'new-client-secret-0123456789', imapOld: 'old-imap-pw-0123456789', imapNew: 'new-imap-pw-0123456789', bob: 'bobs-own-pw-0123456789' };

const names = { pg: `${r.NETWORK}-pg-nc`, old: `${r.NETWORK}-nc-old`, app: `${r.NETWORK}-nc`, volume: `${r.NETWORK}-nc-html` };
let scratch;

function occ(container, ...args) {
    return r.docker('exec', '-u', 'www-data', container, 'php', '/var/www/html/occ', ...args);
}

// Read back through Nextcloud's own classes what only it can decrypt.
function php(container, code) {
    return r.docker('exec', '-u', 'www-data', container, 'php', '-r', `require_once '/var/www/html/lib/base.php'; ${code}`);
}

function config(container) {
    return JSON.parse(php(container, "include '/var/www/html/config/config.php'; echo json_encode($CONFIG);"));
}

function startNextcloud(name, db, extra = []) {
    r.tryDocker('rm', '-f', name);
    r.docker('run', '-d', '--name', name, '--network', r.NETWORK, '-v', `${names.volume}:/var/www/html`,
        '-e', 'POSTGRES_HOST=' + names.pg, '-e', `POSTGRES_DB=${db.name}`, '-e', `POSTGRES_USER=${db.user}`, '-e', `POSTGRES_PASSWORD=${db.password}`,
        ...extra, IMAGE);
}

function status(container, host, urlPath) {
    return r.docker('exec', container, 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', `Host: ${host}`,
        `http://127.0.0.1:${PORT}${urlPath}`);
}

before(async () => {
    r.cleanUp([names.old, names.app, names.pg], [names.volume]);
    await r.startPostgres(names.pg);
    r.createDatabase(names.pg, OLD.db);

    // Where the data was written: installed, signed in to through the realm,
    // Collabora at its public address, one mailbox the platform provisioned
    // and one a person added.
    startNextcloud(names.old, OLD.db, ['-e', 'NEXTCLOUD_ADMIN_USER=admin', '-e', 'NEXTCLOUD_ADMIN_PASSWORD=admin-e2e-Pw-0123456789',
        '-e', `NEXTCLOUD_TRUSTED_DOMAINS=nextcloud.${OLD.domain} nextcloud`]);
    await r.waitFor('Nextcloud', () => occ(names.old, 'status').includes('installed: true'), 600);
    for (const app of ['richdocuments', 'mail']) {
        r.docker('exec', '-u', 'www-data', names.old, 'cp', '-a', `/usr/src/gentian-addons/${app}`, '/var/www/html/custom_apps/');
        occ(names.old, 'app:enable', app);
    }
    occ(names.old, 'app:enable', 'user_oidc');
    occ(names.old, 'user_oidc:provider', 'gentian', '--clientid=gentian-nextcloud-base-ce', `--clientsecret=${SECRETS.oidcOld}`,
        `--discoveryuri=${DISCOVERY}`, `--endsessionendpointuri=https://id.${OLD.domain}/auth/realms/${TENANT}/protocol/openid-connect/logout`,
        '--mapping-uid=gentian_username', '--unique-uid=1', '--check-bearer=0');
    occ(names.old, 'config:app:set', 'richdocuments', 'public_wopi_url', `--value=https://collabora.${OLD.domain}`);
    for (const user of ['anna', 'bob']) {
        r.docker('exec', '-u', 'www-data', '-e', 'OC_PASS=user-e2e-Pw-0123456789', names.old, 'php', '/var/www/html/occ', 'user:add', '--password-from-env', user);
    }
    occ(names.old, 'mail:account:create', 'anna', `anna@${OLD.domain}`, `anna@${OLD.domain}`, 'dovecot', '143', 'none',
        `anna@${OLD.domain}`, SECRETS.imapOld, 'smtp.old', '587', 'none', '', '');
    occ(names.old, 'mail:account:create', 'bob', 'Bob', 'bob@elsewhere.example', 'imap.elsewhere.example', '993', 'ssl',
        'bob@elsewhere.example', SECRETS.bob, 'smtp.elsewhere.example', '465', 'ssl', 'bob@elsewhere.example', SECRETS.bob);
    // The capture is taken in maintenance mode, so config.php comes back so.
    r.docker('exec', '-u', 'www-data', names.old, ...QUIESCE.pre);
    r.docker('rm', '-f', names.old);

    // Where it is put back: the database the platform made here, and a pod
    // given this cluster's credentials.
    r.moveDatabase(names.pg, OLD.db, NEW.db);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-e2e-nextcloud-'));
    for (const dir of ['gentian', 'gentian-mail']) fs.mkdirSync(path.join(scratch, dir), { mode: 0o755 });
    fs.writeFileSync(path.join(scratch, 'gentian', 'oidc-client-secret'), SECRETS.oidcNew, { mode: 0o644 });
    fs.writeFileSync(path.join(scratch, 'gentian-mail', `anna_${NEW.domain}`), SECRETS.imapNew, { mode: 0o644 });
    fs.chmodSync(scratch, 0o755);
    startNextcloud(names.app, NEW.db, ['-e', 'SMTP_HOST=smtp.new', '-e', 'SMTP_PORT=25',
        '-v', `${path.join(scratch, 'gentian')}:/etc/gentian:ro`, '-v', `${path.join(scratch, 'gentian-mail')}:/etc/gentian-mail:ro`]);
    await r.waitFor('Apache', () => status(names.app, 'nextcloud', '/status.php') !== '000', 300);
});

after(() => {
    r.cleanUp([names.old, names.app, names.pg], [names.volume]);
    if (scratch && !process.env.E2E_KEEP) fs.rmSync(scratch, { recursive: true, force: true });
});

test('before the commands, Nextcloud cannot reach the database it was restored into', () => {
    assert.throws(() => occ(names.app, 'config:list', 'core'));
});

test('the post-restore commands run as the platform runs them, and again without changing anything', () => {
    const env = r.restoreEnv({
        app: 'nextcloud-base-ce',
        source: { tenant: TENANT, domain: OLD.domain, platformVersion: '0.5', cluster: 'zrh-1' },
        target: { tenant: TENANT, domain: NEW.domain, cluster: 'gva-2' },
        databases: [[OLD.db.name, NEW.db.name]],
        volumes: [['nextcloud-nextcloud', 'nextcloud-nextcloud']],
    });
    const first = r.runRestore(PROFILE, names.app, env, { user: 'www-data' });
    assert.match(first, /config\.php: dbname, dbuser, dbpassword, trusted_domains/);
    const again = r.runRestore(PROFILE, names.app, env, { user: 'www-data' });
    assert.match(again, /config\.php already names this database and domain/);
    assert.doesNotMatch(again, /setting .* now names/);
    for (const secret of Object.values(SECRETS)) {
        assert.ok(!first.includes(secret) && !again.includes(secret), 'a credential was printed');
    }
    // Resumed, as the restore resumes it.
    r.docker('exec', '-u', 'www-data', names.app, ...QUIESCE.post);
});

test('a bundle that does not say where it was written is restored without failing', () => {
    r.docker('exec', '-u', 'www-data', names.app, ...QUIESCE.pre);
    try {
        r.runRestore(PROFILE, names.app, r.restoreEnv({ app: 'nextcloud-base-ce', target: { tenant: TENANT, domain: NEW.domain } }), { user: 'www-data' });
    } finally {
        r.docker('exec', '-u', 'www-data', names.app, ...QUIESCE.post);
    }
});

test('config.php names the database here and the new domain', () => {
    const c = config(names.app);
    assert.equal(c.dbname, NEW.db.name);
    assert.equal(c.dbuser, NEW.db.user);
    assert.equal(c.dbpassword, NEW.db.password);
    assert.equal(c.dbhost, names.pg);
    assert.ok(c.trusted_domains.includes(`nextcloud.${NEW.domain}`));
    assert.ok(!c.trusted_domains.includes(`nextcloud.${OLD.domain}`));
    assert.equal(c.maintenance, false);
});

test('Nextcloud answers at the new address and not at the old one', () => {
    assert.equal(status(names.app, `nextcloud.${NEW.domain}`, '/login'), '200');
    assert.equal(status(names.app, `nextcloud.${OLD.domain}`, '/login'), '400');
});

test('an app setting that named the old domain names the new one', () => {
    assert.equal(occ(names.app, 'config:app:get', 'richdocuments', 'public_wopi_url'), `https://collabora.${NEW.domain}`);
});

test('the sign-in provider has the new client secret, the same realm and the sign-out address on the new domain', () => {
    const p = JSON.parse(occ(names.app, 'user_oidc:provider', 'gentian', '--output=json'));
    assert.equal(p.clientId, 'gentian-nextcloud-base-ce');
    assert.equal(p.discoveryEndpoint, DISCOVERY);
    assert.equal(p.endSessionEndpoint, `https://id.${NEW.domain}/auth/realms/${TENANT}/protocol/openid-connect/logout`);
    const secret = php(names.app, `$c = \\OCP\\Server::get(\\OCP\\Security\\ICrypto::class);
        $s = \\OCP\\Server::get(\\OCA\\UserOIDC\\Db\\ProviderMapper::class)->findProviderByIdentifier('gentian')->getClientSecret();
        try { $s = $c->decrypt($s); } catch (\\Throwable $e) {} echo $s;`);
    assert.equal(secret, SECRETS.oidcNew);
});

test('the provisioned mailbox has the new address and IMAP credential; the one a person added is untouched', () => {
    const rows = JSON.parse(php(names.app, `$c = \\OCP\\Server::get(\\OCP\\Security\\ICrypto::class);
        $q = \\OCP\\Server::get(\\OCP\\IDBConnection::class)->executeQuery('SELECT user_id, email, inbound_user, inbound_host, outbound_host, inbound_password FROM oc_mail_accounts ORDER BY id');
        $out = []; while ($row = $q->fetch()) { $row['inbound_password'] = $c->decrypt($row['inbound_password']); $out[] = $row; } echo json_encode($out);`));
    const anna = rows.find((a) => a.user_id === 'anna');
    const bob = rows.find((a) => a.user_id === 'bob');
    assert.equal(anna.email, `anna@${NEW.domain}`);
    assert.equal(anna.inbound_user, `anna@${NEW.domain}`);
    assert.equal(anna.inbound_password, SECRETS.imapNew);
    assert.equal(anna.outbound_host, 'smtp.new');
    assert.equal(bob.email, 'bob@elsewhere.example');
    assert.equal(bob.inbound_host, 'imap.elsewhere.example');
    assert.equal(bob.inbound_password, SECRETS.bob);
});
