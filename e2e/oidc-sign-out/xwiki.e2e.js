'use strict';

// XWiki (the catalogue's own image, with the OIDC authenticator it bundles),
// signed in to with its own OIDC client, and signed out of when the person
// signs out at the realm.
//
// What is shown: the realm posts its logout token to the address the platform
// builds from the profile -- XWiki's Service inside the cluster, not its
// public address -- and the session of the person who signed out is nobody's
// afterwards, while another person's goes on.
//
// XWiki is given the profile's own OIDC settings (its oidc.* properties),
// unchanged: it is told the realm's public address, reads the realm's
// description of itself there, and checks a logout token against the keys
// that description names. So the run gives the realm its public name inside
// the network, over TLS, as a cluster does. One thing is this run's and not
// the profile's: the wiki's pages are not installed, which signing in and out
// does not need.
//
//   e2e/oidc-sign-out/run.sh xwiki

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { test, before, after } = require('node:test');
const oidc = require('./lib/oidc');
const forge = require('./lib/forge');

const { setup } = oidc;
const PROFILE = oidc.profileOf('profiles/xwiki/xwiki-ce');
const CLIENT = PROFILE.spec.requires.services.identity.oidc;
const ADDRESS = oidc.signOutAddress(PROFILE);
const IMAGE = process.env.E2E_XWIKI_IMAGE || 'ghcr.io/gentian-org/xwiki:17.10.9-gentian1';
const HOST = ADDRESS.publicHost;
const REALM = oidc.TENANT;
const CLIENT_SECRET = 'e2e-only-client-secret-0123456789';
const APP_PORT = 8080;
const PUBLIC_REALM = `${setup.IDP_BASE}/realms/${REALM}`;

const ANNA = { uid: 'anna', email: 'anna@acme.e2e.test', firstName: 'Anna', lastName: 'Example', password: 'pw-anna-e2e' };
const BEN = { uid: 'ben', email: 'ben@acme.e2e.test', firstName: 'Ben', lastName: 'Example', password: 'pw-ben-e2e' };

const names = { pg: 'oidc-e2e-xwiki-pg', app: 'oidc-e2e-xwiki', service: 'oidc-e2e-xwiki-svc' };
let kc;
let appUpstream;
let service;

// The profile's oidc.* properties, whichever of its settings files carries
// them.
function oidcProperties() {
    const out = {};
    for (const file of Object.values(PROFILE.spec.package.extraValues.customConfigs || {})) {
        for (const [key, value] of Object.entries(file)) {
            if (key.startsWith('oidc.')) out[key] = String(value);
        }
    }
    assert.equal(out['oidc.clientid'], CLIENT.clientId);
    assert.equal(out['oidc.provider'], PUBLIC_REALM);
    return out;
}

function appendTo(file, lines) {
    execFileSync('docker', ['exec', '-i', names.app, 'sh', '-c', `cat >> /usr/local/tomcat/webapps/ROOT/WEB-INF/${file}`],
        { input: '\n' + lines.join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'] });
}

async function up() {
    await setup.waitFor('XWiki', async () => {
        const res = await setup.call('GET', `${appUpstream}/rest/`, { headers: { host: HOST, 'x-forwarded-proto': 'https' } });
        return res.status === 200 || res.status === 302 || res.status === 401;
    }, 420);
}

before(async () => {
    kc = await oidc.startKeycloak();
    const idp = oidc.startPublicIdp(kc);
    await oidc.ensureRealm(kc, REALM, [ANNA, BEN]);
    await oidc.registerClient(kc, REALM, PROFILE, { secret: CLIENT_SECRET, signOutUrl: ADDRESS.url });

    for (const name of Object.values(names)) setup.tryDocker('rm', '-f', name);
    setup.docker('run', '-d', '--name', names.pg, '--network', setup.NETWORK,
        '-e', 'POSTGRES_USER=xwiki', '-e', 'POSTGRES_PASSWORD=xw-e2e', '-e', 'POSTGRES_DB=xwiki', 'postgres:17-alpine');
    await setup.waitFor('PostgreSQL', async () => setup.tryDocker('exec', names.pg, 'pg_isready', '-U', 'xwiki') !== '', 60);
    setup.docker('run', '-d', '--name', names.app, '--network', setup.NETWORK, '-p', `127.0.0.1::${APP_PORT}`,
        '-e', 'DB_USER=xwiki', '-e', 'DB_PASSWORD=xw-e2e', '-e', 'DB_DATABASE=xwiki', '-e', `DB_HOST=${names.pg}`, IMAGE);
    appUpstream = `http://127.0.0.1:${setup.publishedPort(names.app, APP_PORT)}`;
    // The image writes its settings files when it first starts; the
    // profile's are added to them then, as the chart adds them.
    await setup.waitFor('XWiki\'s first start', async () =>
        setup.tryDocker('exec', names.app, 'test', '-f', '/usr/local/tomcat/webapps/ROOT/.first_start_completed') !== null &&
        setup.tryDocker('exec', names.app, 'sh', '-c', 'test -f /usr/local/tomcat/webapps/ROOT/.first_start_completed && echo yes') === 'yes', 120);

    // XWiki trusts the certificate the realm's public address shows, as on
    // a cluster it trusts the cluster's.
    execFileSync('docker', ['cp', idp.certificate, `${names.app}:/tmp/idp.pem`]);
    setup.docker('exec', '-u', '0', names.app, 'sh', '-c',
        'keytool -importcert -noprompt -trustcacerts -alias e2e-idp -file /tmp/idp.pem -cacerts -storepass changeit');

    const properties = {
        ...oidcProperties(),
        'oidc.secret': CLIENT_SECRET,
        // No pages: the run is about the session.
        'distribution.automaticStartOnMainWiki': 'false',
        'distribution.automaticStartOnWiki': 'false',
        'extension.repositories': '',
    };
    appendTo('xwiki.properties', Object.entries(properties).map(([k, v]) => `${k}=${v}`));
    appendTo('xwiki.cfg', [
        'xwiki.authentication.authclass=org.xwiki.contrib.oidc.auth.OIDCAuthServiceImpl',
        // The front door speaks https to the browser.
        'xwiki.url.protocol=https',
    ]);
    // Stopped and started rather than restarted in one step: the port the
    // run reaches it on is given back a moment after the container stops.
    setup.docker('stop', names.app);
    await setup.waitFor('XWiki to start again', async () => {
        setup.docker('start', names.app);
        return true;
    }, 30);
    appUpstream = `http://127.0.0.1:${setup.publishedPort(names.app, APP_PORT)}`;
    await up();

    // The Service the chart makes, by the name the platform builds the
    // address from.
    service = oidc.startService({ name: names.service, address: ADDRESS, target: `http://${names.app}:${APP_PORT}` });
});

after(() => {
    if (process.env.E2E_KEEP) return;
    for (const name of Object.values(names)) setup.tryDocker('rm', '-f', name);
});

function browser() {
    return new oidc.Browser({
        [setup.IDP_HOST]: oidc.keycloak(kc.upstream),
        [HOST]: () => ({ upstream: appUpstream }),
    });
}

// Who XWiki says the browser is: it names the person in a header of every
// answer of its REST interface, and names nobody for a browser without a
// session.
async function whoAmI(b) {
    const res = await b.request('GET', `https://${HOST}/rest/`);
    return res.headers['xwiki-user'] || null;
}

async function signIn(person) {
    const b = browser();
    // XWiki's own sign-in address: with this authenticator it leads to the realm.
    const res = await b.navigate(`https://${HOST}/bin/login/XWiki/XWikiLogin?xredirect=%2Frest%2F`, { credentials: { username: person.uid, password: person.password } });
    assert.ok(b.log.includes(`GET ${HOST}/oidc/authenticator/callback`), `${res.status} after ${b.log.join(' -> ')}`);
    return b;
}

function postToken(token) {
    return setup.call('POST', `${service.upstream}${ADDRESS.path}`, {
        headers: { host: ADDRESS.hostHeader, 'content-type': 'application/x-www-form-urlencoded' },
        body: `logout_token=${encodeURIComponent(token)}`,
    });
}

test('the profile names a path on its own entry, and the address is the app\'s Service inside the cluster', () => {
    assert.equal(ADDRESS.url, 'http://xwiki-ce.tenant-acme.svc.cluster.local:80/oidc/authenticator/backchannel_logout');
    assert.equal(CLIENT.backchannelLogoutUrl, undefined, 'the free-form address is withdrawn');
});

test('a person signs in to XWiki through the realm', async () => {
    const anna = await signIn(ANNA);
    assert.equal(await whoAmI(anna), `xwiki:XWiki.${ANNA.uid}`);
});

test('signing out at the realm ends that person\'s session in XWiki, and nobody else\'s', async () => {
    const anna = await signIn(ANNA);
    const ben = await signIn(BEN);
    assert.equal(await whoAmI(anna), `xwiki:XWiki.${ANNA.uid}`);
    assert.equal(await whoAmI(ben), `xwiki:XWiki.${BEN.uid}`);

    const before = (await oidc.posts(service)).length;
    await setup.signOutAtRealm(anna, REALM);
    const posted = await oidc.waitForPosts(service, before + 1);
    assert.equal(posted.length, before + 1, 'the realm told XWiki once');
    const post = posted[posted.length - 1];
    assert.equal(post.host, ADDRESS.hostHeader);
    assert.equal(post.path, ADDRESS.path);
    assert.ok(post.status >= 200 && post.status < 300, `XWiki answered ${post.status}`);
    const token = oidc.logoutTokenOf(post);
    assert.equal(token.aud, CLIENT.clientId);
    assert.equal(token.iss, PUBLIC_REALM);

    // Her cookie is nobody's: the next person at this browser is not her.
    assert.notEqual(await whoAmI(anna), `xwiki:XWiki.${ANNA.uid}`);
    // Ben is where he was.
    assert.equal(await whoAmI(ben), `xwiki:XWiki.${BEN.uid}`);
});

test('a logout token the realm did not sign ends no session', async () => {
    const ben = await signIn(BEN);
    const anna = await signIn(ANNA);
    const before = (await oidc.posts(service)).length;
    await setup.signOutAtRealm(anna, REALM);
    const real = (await oidc.waitForPosts(service, before + 1)).pop();
    const realToken = new URLSearchParams(real.body).get('logout_token');

    const id = await setup.userId(kc, REALM, BEN.email);
    const sessions = JSON.parse((await kc.admin('GET', `/realms/${REALM}/users/${id}/sessions`)).body);
    assert.ok(sessions.length > 0);
    for (const session of sessions) {
        const claims = forge.claims({ issuer: PUBLIC_REALM, audience: CLIENT.clientId, sub: id, sid: session.id });
        const forged = await postToken(forge.signedByAStranger(claims, forge.headerOf(realToken).kid));
        assert.ok(forged.status >= 400, `a token signed with another key was answered ${forged.status}`);
        const plain = await postToken(forge.unsigned(claims));
        assert.ok(plain.status >= 400, `a token nobody signed was answered ${plain.status}`);
    }
    assert.equal(await whoAmI(ben), `xwiki:XWiki.${BEN.uid}`);
});
