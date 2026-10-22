'use strict';

// XWiki (the catalogue's own image, with the OIDC authenticator it bundles)
// imported into another cluster under another domain. On the old one its
// pages are installed and two people sign in through the tenant's realm at
// id.<old kernel domain>. Its volume and database come back, the database
// under another name and owned by another role, and the realm is reached at
// id.<new kernel domain> with a new client secret: the same people, with the
// same subjects, under another issuer.
//
// XWiki finds a returning person by issuer and subject. Before the profile's
// post-restore commands, a person who signs in gets a new, empty account;
// after them, and after XWiki is started again as the platform starts it
// again, a person who signs in is the account they had. The wiki's
// descriptor names the new host and the accounts' addresses the new domain.
//
// The realm is one Keycloak whose realm is given another public address
// (its frontendUrl), so the people and their subjects are the same on both
// sides, as an import brings them. XWiki is given the profile's own oidc.*
// settings and the profile's offline flavor settings; the settings the
// chart's start script writes are written the same way here.
//
//   e2e/restore-rewrites/run.sh xwiki

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const oidc = require('../oidc-sign-out/lib/oidc');

// One network for the realm and the app: the realm's, which keeps its
// addresses outside the private ranges (see the sign-out runs).
process.env.E2E_RESTORE_NETWORK = oidc.setup.NETWORK;
const r = require('./lib/restore');

const { setup } = oidc;
const PROFILE_DIR = 'profiles/xwiki/xwiki-ce';
const PROFILE = r.profileOf(PROFILE_DIR);
const VALUES = PROFILE.spec.package.extraValues;
const IMAGE = process.env.E2E_XWIKI_IMAGE || `${VALUES.image.name}:${VALUES.image.tag}`;
const CLIENT = PROFILE.spec.requires.services.identity.oidc;
const PORT = VALUES.service.internalPort;
const WEBINF = '/usr/local/tomcat/webapps/ROOT/WEB-INF';

const TENANT = oidc.TENANT;
const OLD = {
    kernel: oidc.KERNEL_DOMAIN, domain: oidc.DOMAIN, idp: setup.IDP_HOST, secret: 'old-client-secret-0123456789',
    db: { name: 'acme_xwiki_old', user: 'acme_xwiki_old', password: 'old-db-pw-0123456789' },
};
const NEW = {
    kernel: 'moved.test', domain: `${TENANT}.moved.test`, idp: 'id.moved.test', secret: 'new-client-secret-0123456789',
    db: { name: 'acme_xwiki', user: 'acme_xwiki', password: 'new-db-pw-0123456789' },
};
for (const side of [OLD, NEW]) {
    side.host = `wiki.${side.domain}`;
    side.issuer = `https://${side.idp}/auth/realms/${TENANT}`;
}

const ANNA = { address: `anna@${OLD.domain}`, recovery: 'anna@home.example', firstName: 'Anna', lastName: 'Example', password: 'pw-anna-e2e-0123' };
const BEN = { address: `ben@${OLD.domain}`, recovery: 'ben@home.example', firstName: 'Ben', lastName: 'Example', password: 'pw-ben-e2e-0123' };
const A = oidc.xwikiPage(ANNA);
const B = oidc.xwikiPage(BEN);
const SECRETS = [OLD.secret, NEW.secret, OLD.db.password, NEW.db.password, ANNA.password, BEN.password];

const names = { pg: `${setup.NETWORK}-xw-pg`, old: `${setup.NETWORK}-xw-old`, app: `${setup.NETWORK}-xw`, volume: `${setup.NETWORK}-xw-data` };
let kc;
let idps;
let upstream;

// The profile's XWiki settings, as the chart writes them into xwiki.cfg and
// xwiki.properties, with the placeholders filled in for one side.
function settingsFor(side) {
    const text = fs.readFileSync(path.join(r.REPO, PROFILE_DIR, 'profile.yaml'), 'utf8');
    const filled = r.YAML.parse(oidc.fill(text, { KERNEL_DOMAIN: side.kernel, TENANT_DOMAIN: side.domain }));
    const files = filled.spec.package.extraValues.customConfigs;
    assert.equal(files['xwiki.properties']['oidc.provider'], side.issuer);
    return files;
}

function appendTo(container, file, settings) {
    execFileSync('docker', ['exec', '-i', container, 'sh', '-c', `cat >> ${WEBINF}/${file}`],
        { input: '\n' + Object.entries(settings).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'] });
}

// docker picks the published port when the container starts; one taken
// meanwhile fails the start, and another start picks another.
async function startPublished(name) {
    await setup.waitFor(`${name} to start`, async () => {
        setup.tryDocker('start', name);
        return setup.tryDocker('inspect', '-f', '{{.State.Running}}', name) === 'true';
    }, 60);
    return `http://127.0.0.1:${setup.publishedPort(name, PORT)}`;
}

async function answers(host) {
    const res = await setup.call('GET', `${upstream}/rest/`, { headers: { host, 'x-forwarded-proto': 'https' } });
    return [200, 302, 401].includes(res.status);
}

// XWiki on the volume and database of one side, set up as the chart sets it
// up: the image writes its settings files on its first start, and the
// profile's settings are written into them before Tomcat starts again.
async function startXWiki(name, side) {
    setup.tryDocker('rm', '-f', name);
    execFileSync('docker', ['create', '--name', name, '--network', setup.NETWORK, '-p', `127.0.0.1::${PORT}`,
        '-v', `${names.volume}:/usr/local/xwiki/data`,
        '-e', `DB_HOST=${names.pg}`, '-e', `DB_DATABASE=${side.db.name}`, '-e', `DB_USER=${side.db.user}`, '-e', `DB_PASSWORD=${side.db.password}`,
        IMAGE], { stdio: 'ignore' });
    await startPublished(name);
    await setup.waitFor('XWiki\'s first start', async () =>
        setup.tryDocker('exec', name, 'sh', '-c', 'test -f /usr/local/tomcat/webapps/ROOT/.first_start_completed && echo yes') === 'yes', 180);
    // XWiki trusts the certificate the realm's public address shows, as on a
    // cluster it trusts the cluster's.
    execFileSync('docker', ['cp', idps[side.idp], `${name}:/tmp/idp.pem`]);
    setup.docker('exec', '-u', '0', name, 'sh', '-c', 'keytool -importcert -noprompt -trustcacerts -alias e2e-idp -file /tmp/idp.pem -cacerts -storepass changeit');
    const files = settingsFor(side);
    appendTo(name, 'xwiki.properties', { ...files['xwiki.properties'], 'oidc.secret': side.secret });
    // The front door speaks https to the browser.
    appendTo(name, 'xwiki.cfg', { ...files['xwiki.cfg'], 'xwiki.url.protocol': 'https' });
    setup.docker('stop', name);
    upstream = await startPublished(name);
    await setup.waitFor('XWiki', () => answers(side.host), 420);
}

// The headless install of the flavor, the wiki's pages, has finished. Read
// from the log, which is too long to take whole.
function flavorInstalled(container) {
    const done = 'Finished job of type [install] with identifier [[extension, action, org.xwiki.platform:xwiki-platform-distribution-flavor-mainwiki';
    try {
        execFileSync('sh', ['-c', 'docker logs "$1" 2>&1 | grep -qF "$2"', 'sh', container, done], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function browser() {
    return new oidc.Browser({
        [OLD.idp]: oidc.keycloak(kc.upstream),
        [NEW.idp]: oidc.keycloak(kc.upstream),
        [OLD.host]: () => ({ upstream }),
        [NEW.host]: () => ({ upstream }),
    });
}

// The account XWiki signs a person in as, through XWiki's own sign-in
// address, which leads to the realm.
async function signIn(side, person) {
    const b = browser();
    const res = await b.navigate(`https://${side.host}/bin/login/XWiki/XWikiLogin?xredirect=%2Frest%2F`,
        { credentials: { username: person.address, password: person.password } });
    assert.ok(b.log.includes(`GET ${side.host}/oidc/authenticator/callback`), `${res.status} after ${b.log.join(' -> ')}`);
    assert.ok(b.log.includes(`GET ${side.idp}/auth/realms/${TENANT}/protocol/openid-connect/auth`), b.log.join(' -> '));
    const me = await b.request('GET', `https://${side.host}/rest/`);
    return me.headers['xwiki-user'] || null;
}

// The realm as one cluster has it: its public address, and the client's
// secret and addresses there.
async function realmAt(side, clientUuid) {
    const realm = JSON.parse((await kc.admin('GET', `/realms/${TENANT}`)).body);
    await kc.admin('PUT', `/realms/${TENANT}`, { ...realm, attributes: { ...(realm.attributes || {}), frontendUrl: `https://${side.idp}/auth` } });
    const client = JSON.parse((await kc.admin('GET', `/realms/${TENANT}/clients/${clientUuid}`)).body);
    await kc.admin('PUT', `/realms/${TENANT}/clients/${clientUuid}`, {
        ...client, secret: side.secret,
        redirectUris: CLIENT.redirectUris.map((u) => oidc.fill(u, { TENANT_DOMAIN: side.domain })),
    });
}

function query(sql) {
    return r.docker('exec', names.pg, 'psql', '-qtA', '-U', 'postgres', '-d', NEW.db.name, '-c', sql);
}

function property(cls, prop) {
    return query(`SELECT o.xwo_name || '=' || s.xws_value FROM xwikiobjects o JOIN xwikistrings s ON s.xws_id = o.xwo_id
        WHERE o.xwo_classname = '${cls}' AND s.xws_name = '${prop}'`).split('\n').filter(Boolean).sort();
}

before(async () => {
    r.cleanUp([names.old, names.app, names.pg], [names.volume]);
    kc = await oidc.startKeycloak();
    idps = {};
    for (const side of [OLD, NEW]) idps[side.idp] = oidc.startPublicIdp(kc, side.idp).certificate;
    await oidc.ensureRealm(kc, TENANT, [ANNA, BEN]);
    const profile = oidc.profileOf(PROFILE_DIR);
    const clientUuid = await oidc.registerClient(kc, TENANT, profile, { secret: OLD.secret });
    await realmAt(OLD, clientUuid);

    await r.startPostgres(names.pg);
    r.createDatabase(names.pg, OLD.db);

    // Where the data was written: the wiki's pages installed offline, as the
    // profile installs them, and two people signed in.
    await startXWiki(names.old, OLD);
    await setup.waitFor('the wiki\'s pages', async () => {
        await answers(OLD.host);
        return flavorInstalled(names.old);
    }, 900);
    assert.equal(await signIn(OLD, ANNA), `xwiki:${A}`);
    assert.equal(await signIn(OLD, BEN), `xwiki:${B}`);
    r.docker('rm', '-f', names.old);

    // Where it is put back: the database the platform made here, the realm
    // at this cluster's address with this cluster's client secret, and a pod
    // given this cluster's values.
    r.moveDatabase(names.pg, OLD.db, NEW.db);
    await realmAt(NEW, clientUuid);
    await startXWiki(names.app, NEW);
});

after(() => {
    r.cleanUp([names.old, names.app, names.pg], [names.volume]);
});

test('the data put back names the old cluster and domain', () => {
    assert.deepEqual(property('XWiki.OIDC.UserClass', 'issuer'), [`${A}=${OLD.issuer}`, `${B}=${OLD.issuer}`]);
    assert.deepEqual(property('XWiki.XWikiServerClass', 'server'), [`XWiki.XWikiServerXwiki=${OLD.host}`]);
    assert.deepEqual(property('XWiki.XWikiUsers', 'email'), [`${A}=${ANNA.address}`, `${B}=${BEN.address}`]);
});

test('before the commands, a person who signs in gets a new account, not the one they had', async () => {
    assert.equal(await signIn(NEW, BEN), `xwiki:${B}-0`);
});

test('the post-restore commands run as the platform runs them, and again without changing anything', async () => {
    const env = r.restoreEnv({
        app: 'xwiki-ce',
        source: { tenant: TENANT, domain: OLD.domain, kernelDomain: OLD.kernel, platformVersion: '0.5', cluster: 'zrh-1' },
        target: { tenant: TENANT, domain: NEW.domain, kernelDomain: NEW.kernel, cluster: 'gva-2' },
        databases: [[OLD.db.name, NEW.db.name]],
        roles: [[OLD.db.user, NEW.db.user]],
        volumes: [['xwiki-data-xwiki-ce-0', 'xwiki-data-xwiki-ce-0']],
    });
    const first = r.runRestore(PROFILE, names.app, env);
    assert.match(first, new RegExp(`2 account\\(s\\) now sign in through ${NEW.issuer.replace(/\./g, '\\.')}`));
    // Ben's second account, too: made with the address he signed in with.
    assert.match(first, /3 account address\(es\) moved to the new domain/);
    assert.match(first, /XWiki\.XWikiServerXwiki \(server\) now names the new domain/);
    // Ben signed in between the restore and the commands.
    assert.ok(first.includes(`${B} and ${B}-0 are one person at the realm`), first);
    const again = r.runRestore(PROFILE, names.app, env);
    assert.match(again, /the wiki already names this cluster and domain/);
    assert.doesNotMatch(again, /now sign in through|moved to the new domain|now names the new domain/);
    for (const secret of SECRETS) {
        assert.ok(!first.includes(secret) && !again.includes(secret), 'a credential was printed');
    }

    // A bundle that does not say where it was written changes nothing and
    // does not fail.
    const blind = r.runRestore(PROFILE, names.app, r.restoreEnv({ app: 'xwiki-ce', target: { tenant: TENANT, domain: NEW.domain, kernelDomain: NEW.kernel } }));
    assert.match(blind, /nothing to rewrite/);

    // Started again once the commands have run, as the platform starts it
    // again after a restore that paused it by scaling it down.
    setup.docker('stop', names.app);
    upstream = await startPublished(names.app);
    await setup.waitFor('XWiki', () => answers(NEW.host), 420);
});

test('the wiki names the new issuer, host and domain', () => {
    assert.deepEqual(property('XWiki.OIDC.UserClass', 'issuer'), [`${A}=${NEW.issuer}`, `${B}-0=${NEW.issuer}`, `${B}=${NEW.issuer}`]);
    assert.deepEqual(property('XWiki.XWikiServerClass', 'server'), [`XWiki.XWikiServerXwiki=${NEW.host}`]);
    assert.deepEqual(property('XWiki.XWikiUsers', 'email'), [`${A}=anna@${NEW.domain}`, `${B}-0=ben@${NEW.domain}`, `${B}=ben@${NEW.domain}`]);
});

test('a person who signed in on the old cluster signs in here and is the account they had', async () => {
    assert.equal(await signIn(NEW, ANNA), `xwiki:${A}`);
});
