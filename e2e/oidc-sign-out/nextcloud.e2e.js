'use strict';

// Nextcloud (the catalogue's own image), signed in to with its own OIDC
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
const IMAGE = `${VALUES.image.registry}/${VALUES.image.repository}:${VALUES.image.tag}`;
const HOST = ADDRESS.publicHost;
const REALM = oidc.TENANT;
// The port the image's web server listens on.
const APP_PORT = 8080;
const CLIENT_SECRET = 'e2e-only-client-secret-0123456789';

const ANNA = { uid: 'anna', email: 'anna@acme.e2e.test', firstName: 'Anna', lastName: 'Example', password: 'pw-anna-e2e' };
const BEN = { uid: 'ben', email: 'ben@acme.e2e.test', firstName: 'Ben', lastName: 'Example', password: 'pw-ben-e2e' };

const names = { app: 'oidc-e2e-nextcloud', service: 'oidc-e2e-nextcloud-svc' };
let kc;
let appUpstream;
let service;
let scratch;

function occ(...args) {
    return setup.docker('exec', names.app, 'php', '/var/www/html/occ', ...args);
}

before(async () => {
    kc = await oidc.startKeycloak();
    await oidc.ensureRealm(kc, REALM, [ANNA, BEN]);
    await oidc.registerClient(kc, REALM, PROFILE, { secret: CLIENT_SECRET, signOutUrl: ADDRESS.url });

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
    const res = await b.navigate(`https://${HOST}/apps/user_oidc/login/${provider.id}`, { credentials: { username: person.uid, password: person.password } });
    assert.ok(res.status < 400, `${res.status} after ${b.log.join(' -> ')}`);
    return b;
}

async function realmSessions(person) {
    const id = await setup.userId(kc, REALM, person.email);
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

test('a person signs in to Nextcloud through the realm', async () => {
    const anna = await signIn(ANNA);
    assert.deepEqual(await whoAmI(anna), { status: 200, email: ANNA.email });
});

test('signing out at the realm ends that person\'s session in Nextcloud, and nobody else\'s', async () => {
    const anna = await signIn(ANNA);
    const ben = await signIn(BEN);
    assert.equal((await whoAmI(anna)).email, ANNA.email);
    assert.equal((await whoAmI(ben)).email, BEN.email);

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
    assert.deepEqual(await whoAmI(ben), { status: 200, email: BEN.email });
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
    const again = await postToken(realToken);
    assert.notEqual(again.status, 200, 'the realm\'s own token, a second time');
    assert.deepEqual(await whoAmI(ben), { status: 200, email: BEN.email });
});
