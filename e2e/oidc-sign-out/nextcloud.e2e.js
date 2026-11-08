'use strict';

// Nextcloud (the catalog's own image), signed in to with its own OIDC
// client, and signed out of when the person signs out at the realm.
//
// What is shown: the realm posts its logout token to the address the platform
// builds from the profile -- Nextcloud's Service inside the cluster, not its
// public address -- Nextcloud accepts it under that name, and the session
// cookie of the person who signed out opens nothing afterwards, while another
// person's goes on working.
//
//   e2e/oidc-sign-out/run.sh nextcloud

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const oidc = require('./lib/oidc');
const forge = require('./lib/forge');

const { setup } = oidc;
const PROFILE = oidc.profileOf('profiles/nextcloud/base/base-ce');
const CLIENT = PROFILE.spec.requires.services.identity.oidc;
const ADDRESS = oidc.signOutAddress(PROFILE);
const VALUES = PROFILE.spec.package.extraValues;
const IMAGE = process.env.E2E_NEXTCLOUD_IMAGE || `${VALUES.image.registry}/${VALUES.image.repository}:${VALUES.image.tag}`;
const HOST = ADDRESS.publicHost;
const REALM = oidc.TENANT;
// The port the image's web server listens on.
const APP_PORT = 8080;
const CLIENT_SECRET = 'e2e-only-client-secret-0123456789';

// A person signs in with their workspace address; the other address is
// their own, for the realm to mail a password reset to, and no app's to know.
const ANNA = { address: `anna@${oidc.DOMAIN}`, recovery: 'anna@home.example', firstName: 'Anna', lastName: 'Example', password: 'pw-anna-e2e' };
const BEN = { address: `ben@${oidc.DOMAIN}`, recovery: 'ben@home.example', firstName: 'Ben', lastName: 'Example', password: 'pw-ben-e2e' };

const names = { app: 'oidc-e2e-nextcloud', service: 'oidc-e2e-nextcloud-svc' };
let kc;
let clientUuid;
let appUpstream;
let service;
let scratch;

function occ(...args) {
    return setup.docker('exec', names.app, 'php', '/var/www/html/occ', ...args);
}

before(async () => {
    kc = await oidc.startKeycloak();
    await oidc.ensureRealm(kc, REALM, [ANNA, BEN]);
    clientUuid = await oidc.registerClient(kc, REALM, PROFILE, { secret: CLIENT_SECRET, signOutUrl: ADDRESS.url });

    // What the chart gives the container from the profile's values: the host
    // it answers at and the names it trusts, and the profile's own settings
    // file.
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oidc-e2e-nextcloud-'));
    fs.chmodSync(scratch, 0o755);
    fs.mkdirSync(path.join(scratch, 'secrets'));
    fs.writeFileSync(path.join(scratch, 'secrets', 'oidc-client-secret'), CLIENT_SECRET);
    for (const f of ['secrets', 'secrets/oidc-client-secret']) fs.chmodSync(path.join(scratch, f), f === 'secrets' ? 0o755 : 0o644);
    const trusted = [VALUES.nextcloud.host, ...(VALUES.nextcloud.trustedDomains || [])];
    assert.equal(VALUES.nextcloud.host, HOST);

    for (const name of Object.values(names)) setup.tryDocker('rm', '-f', name);
    setup.docker('run', '-d', '--name', names.app, '--network', setup.NETWORK, '-p', `127.0.0.1::${APP_PORT}`,
        '-e', 'SQLITE_DATABASE=nextcloud', '-e', 'NEXTCLOUD_ADMIN_USER=admin', '-e', 'NEXTCLOUD_ADMIN_PASSWORD=admin-e2e-Pw-0123456789',
        '-e', `NEXTCLOUD_TRUSTED_DOMAINS=${trusted.join(' ')}`,
        '-v', `${path.join(scratch, 'secrets')}:/etc/gentian:ro`,
        IMAGE);
    appUpstream = `http://127.0.0.1:${setup.publishedPort(names.app, APP_PORT)}`;
    await setup.waitFor('Nextcloud', async () => {
        const res = await setup.call('GET', `${appUpstream}/status.php`, { headers: { host: HOST, 'x-forwarded-proto': 'https' } });
        return res.status === 200 && JSON.parse(res.body).installed === true;
    }, 420);

    // The profile's settings file, which the chart puts beside Nextcloud's
    // own. (Written once Nextcloud has installed itself: a file mounted into
    // that directory beforehand makes the directory somebody else's.)
    execFileSync('docker', ['exec', '-i', names.app, 'sh', '-c', 'cat > /var/www/html/config/gentian-proxy.config.php'],
        { input: VALUES.nextcloud.configs['gentian-proxy.config.php'], stdio: ['pipe', 'pipe', 'pipe'] });

    // The profile's own post-installation hook, as the chart runs it: it
    // registers the realm with Nextcloud's OIDC app.
    execFileSync('docker', ['exec', '-i', names.app, 'bash', '-s'],
        { input: VALUES.nextcloud.hooks['post-installation'], stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000 });

    // The Service the chart makes, by the name the platform builds the
    // address from.
    service = oidc.startService({ name: names.service, address: ADDRESS, target: `http://${names.app}:${APP_PORT}` });
});

after(() => {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    if (process.env.E2E_KEEP) return;
    for (const name of Object.values(names)) setup.tryDocker('rm', '-f', name);
});

function browser() {
    return new oidc.Browser({
        [setup.IDP_HOST]: oidc.keycloak(kc.upstream),
        [HOST]: () => ({ upstream: appUpstream }),
    });
}

// Who Nextcloud says the browser is. By address: the account's name is the
// profile's to choose (it asks for one that is unique across providers).
async function whoAmI(b) {
    const res = await b.request('GET', `https://${HOST}/ocs/v2.php/cloud/user?format=json`, { headers: { 'OCS-APIRequest': 'true' } });
    return { status: res.status, email: res.status === 200 ? JSON.parse(res.body).ocs.data.email : null };
}

async function signIn(person) {
    const b = browser();
    const provider = JSON.parse(occ('user_oidc:provider', '--output=json')).find((p) => p.identifier === 'gentian');
    const res = await b.navigate(`https://${HOST}/apps/user_oidc/login/${provider.id}`, { credentials: { username: person.address, password: person.password } });
    assert.ok(res.status < 400, `${res.status} after ${b.log.join(' -> ')}`);
    return b;
}

async function realmSessions(person) {
    const id = await oidc.personId(kc, REALM, person);
    return { id, sessions: JSON.parse((await kc.admin('GET', `/realms/${REALM}/users/${id}/sessions`)).body) };
}

function postToken(token) {
    return setup.call('POST', `${service.upstream}${ADDRESS.path}`, {
        headers: { host: ADDRESS.hostHeader, 'content-type': 'application/x-www-form-urlencoded' },
        body: `logout_token=${encodeURIComponent(token)}`,
    });
}

test('the profile names a path on its own entry, and the address is the app\'s Service inside the cluster', () => {
    assert.equal(ADDRESS.url, 'http://nextcloud.tenant-acme.svc.cluster.local:8080/apps/user_oidc/backchannel-logout/gentian');
    assert.equal(CLIENT.backchannelLogoutUrl, undefined, 'the free-form address is withdrawn');
});

test('every mapper that writes the e-mail claim for Nextcloud reads the workspace address', async () => {
    const sources = await oidc.emailSources(kc, REALM, clientUuid);
    assert.ok(sources.some((s) => s.from === PROFILE.catalog.spec.packs[CLIENT.clientId].scopeName), 'the profile\'s pack writes the claim');
    assert.deepEqual(sources.filter((s) => s.reads !== 'username'), []);
});

test('a person signs in to Nextcloud through the realm, and Nextcloud holds their workspace address', async () => {
    const anna = await signIn(ANNA);
    const who = await whoAmI(anna);
    assert.deepEqual(who, { status: 200, email: ANNA.address });
    assert.notEqual(who.email, ANNA.recovery, 'the address a password reset goes to is not Nextcloud\'s to know');
});

test('signing out at the realm ends that person\'s session in Nextcloud, and nobody else\'s', async () => {
    const anna = await signIn(ANNA);
    const ben = await signIn(BEN);
    assert.equal((await whoAmI(anna)).email, ANNA.address);
    assert.equal((await whoAmI(ben)).email, BEN.address);

    const before = (await oidc.posts(service)).length;
    await setup.signOutAtRealm(anna, REALM);
    const posted = await oidc.waitForPosts(service, before + 1);
    assert.equal(posted.length, before + 1, 'the realm told Nextcloud once');
    const post = posted[posted.length - 1];
    // Under the Service's name inside the cluster, and accepted there.
    assert.equal(post.host, ADDRESS.hostHeader);
    assert.equal(post.path, ADDRESS.path);
    assert.equal(post.status, 200, 'Nextcloud accepted the notice');
    const token = oidc.logoutTokenOf(post);
    assert.equal(token.aud, CLIENT.clientId);
    assert.equal(token.iss, `${setup.IDP_BASE}/realms/${REALM}`);
    assert.ok(token.sid && token.sub && token.events['http://schemas.openid.net/event/backchannel-logout']);

    // Her cookies open nothing: the next person at this browser is not her.
    assert.equal((await whoAmI(anna)).status, 401);
    // Ben is where he was.
    assert.deepEqual(await whoAmI(ben), { status: 200, email: BEN.address });
});

test('a logout token the realm did not sign, or sent before, ends no session', async () => {
    const ben = await signIn(BEN);
    // The realm's own token for somebody else, to have its key's name and to
    // present it again.
    const anna = await signIn(ANNA);
    const before = (await oidc.posts(service)).length;
    await setup.signOutAtRealm(anna, REALM);
    const real = (await oidc.waitForPosts(service, before + 1)).pop();
    const realToken = new URLSearchParams(real.body).get('logout_token');

    const { id, sessions } = await realmSessions(BEN);
    assert.ok(sessions.length > 0);
    for (const session of sessions) {
        const claims = forge.claims({ issuer: `${setup.IDP_BASE}/realms/${REALM}`, audience: CLIENT.clientId, sub: id, sid: session.id });
        const forged = await postToken(forge.signedByAStranger(claims, forge.headerOf(realToken).kid));
        assert.notEqual(forged.status, 200, 'a token signed with another key');
        const plain = await postToken(forge.unsigned(claims));
        assert.notEqual(plain.status, 200, 'a token nobody signed');
    }
    // The realm's own token a second time names a session already ended:
    // user_oidc 8.11.0 answers that with 200, as the specification asks, and
    // ends nothing -- which is what the last line shows.
    await postToken(realToken);
    assert.deepEqual(await whoAmI(ben), { status: 200, email: BEN.address });
});

// Where the tiles land. Not sign-out, but this is the run that signs a person
// in to the catalog's Nextcloud the way the platform does.
function tilePath(profile, entry) {
    return profile.spec.expose.find((e) => e.name === entry).tile.path;
}

test('the Files tile and the bare address open Files, not the Dashboard', async () => {
    const anna = await signIn(ANNA);
    const files = await anna.request('GET', `https://${HOST}${tilePath(PROFILE, 'web')}`);
    assert.equal(files.status, 200, `${tilePath(PROFILE, 'web')} answered ${files.status}`);
    const bare = await anna.request('GET', `https://${HOST}/`);
    assert.ok([302, 303].includes(bare.status), `/ answered ${bare.status}`);
    assert.match(new URL(bare.headers.location, `https://${HOST}/`).pathname, /\/apps\/files\/?$/);
});

test('an Office tile opens the person\'s newest file of its kind, or a new one from the template', async () => {
    // Office switched on as its add-on is: copied from the image's staging and
    // enabled, then the container started again -- the activation hook runs
    // before the web server starts, and a web server already running keeps
    // the apps it read in APCu. No Collabora is needed to choose the file.
    setup.docker('exec', names.app, 'cp', '-a', '/usr/src/gentian-addons/richdocuments', '/var/www/html/custom_apps/');
    occ('app:enable', 'richdocuments');
    setup.docker('restart', names.app);
    // A port Docker chose may be another after a restart.
    appUpstream = `http://127.0.0.1:${setup.publishedPort(names.app, APP_PORT)}`;
    await setup.waitFor('Nextcloud', async () => {
        const res = await setup.call('GET', `${appUpstream}/status.php`, { headers: { host: HOST, 'x-forwarded-proto': 'https' } });
        return res.status === 200;
    }, 120);
    const office = oidc.profileOf('profiles/nextcloud/addons/richdocuments-ce');
    const ben = await signIn(BEN);
    async function open(kind) {
        const res = await ben.request('GET', `https://${HOST}${tilePath(office, kind)}`);
        assert.equal(res.status, 303, `${tilePath(office, kind)} answered ${res.status}`);
        const id = /\/f\/(\d+)$/.exec(new URL(res.headers.location, `https://${HOST}/`).pathname);
        assert.ok(id, `${kind} went to ${res.headers.location}, not to a file`);
        return id[1];
    }
    // Nextcloud's samples at sign-up hold a .docx in Documents, which is the
    // newest document Ben has; spreadsheets and presentations he has only
    // in his templates folder, which is not looked in.
    const document = await open('document');
    assert.equal(await open('document'), document, 'the same document again');
    const spreadsheet = await open('spreadsheet');
    assert.equal(await open('spreadsheet'), spreadsheet, 'the second press opens the spreadsheet the first made');
    const presentation = await open('presentation');
    assert.equal(new Set([document, spreadsheet, presentation]).size, 3);
    const made = setup.docker('exec', names.app, 'sh', '-c', 'find /var/www/html/data -path "*/files/New *" -printf "%f\\n"');
    assert.deepEqual(made.split('\n').sort(), ['New Presentation.odp', 'New Spreadsheet.ods'], 'made from the templates, once each');
});
