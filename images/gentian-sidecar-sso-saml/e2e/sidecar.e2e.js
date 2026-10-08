'use strict';

// The sidecar against a real Keycloak, with the smallest handler, at each of
// the three kinds of address an app can have.
//
//   docker build -t sso-sidecar:e2e ..   &&   node --test e2e/sidecar.e2e.js

const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { Browser, frontDoor, keycloak } = require('./lib/browser');
const setup = require('./lib/setup');

const ANNA = { email: 'anna@acme.e2e.test', firstName: 'Anna', lastName: "O'Example", password: 'pw-anna-e2e', subject: 'sub-anna', name: "Anna O'Example" };
const BEN = { email: 'ben@acme.e2e.test', firstName: 'Ben', lastName: 'Example', password: 'pw-ben-e2e', subject: 'sub-ben', name: 'Ben Example' };

// Where an app answers: a tenant under the cluster's domain, the one tenant
// of a single-tenancy cluster, and a tenant on a domain of its own. The realm
// differs with the tenant, not with the address.
const PLACES = [
    { label: 'tenant under the cluster domain', host: 'auto.acme.e2e.test', realm: 'acme' },
    { label: 'single-tenancy cluster', host: 'auto.e2e.test', realm: 'user' },
    { label: 'tenant on its own domain', host: 'auto.acme-corp.test', realm: 'acme' },
];

let kc;
const started = [];

before(async () => {
    kc = await setup.startKeycloak();
    for (const realm of ['acme', 'user']) await setup.ensureRealm(kc, realm, [ANNA, BEN]);
    for (const [i, place] of PLACES.entries()) {
        await setup.ensureSidecarClient(kc, place.realm, place.host);
        place.sidecar = setup.startSidecar({
            name: `sso-e2e-sidecar-${i}`, host: place.host, realm: place.realm, kc,
            handlerFile: path.join(__dirname, 'handlers', 'echo.js'),
        });
        started.push(place.sidecar.name);
    }
    for (const place of PLACES) await setup.sidecarReady(place.sidecar);
});

after(() => {
    if (process.env.E2E_KEEP) return;
    for (const name of started) setup.tryDocker('rm', '-f', name);
});

function browserFor(place, door) {
    return new Browser({
        [setup.IDP_HOST]: keycloak(kc.upstream),
        [place.host]: frontDoor({ door, sidecar: place.sidecar.upstream, realm: place.realm, entryPaths: ['/'] }),
    });
}

for (const place of PLACES) {
    test(`${place.label}: a person signed in at the realm is signed in to the app without being asked`, async () => {
        const door = { person: ANNA };
        const browser = browserFor(place, door);
        // The sign-in at the desktop: the realm's session exists before the app is opened.
        const first = await browser.navigate(`https://${place.host}/`, { credentials: { username: ANNA.email, password: ANNA.password } });
        assert.equal(first.status, 200, browser.log.join(' -> '));
        assert.equal(new URL(first.url).pathname, '/signed-in');
        const session = browser.cookie(place.host, 'e2e_session');
        assert.ok(session, 'the app session cookie is set');
        assert.match(session.raw, /; Path=\/; Max-Age=\d+; Secure; SameSite=Lax; HttpOnly$/);
        const [email, seconds] = Buffer.from(session.value, 'base64url').toString().split('|');
        assert.equal(email, ANNA.email);
        assert.ok(Number(seconds) > 0 && Number(seconds) <= 3600, seconds);
        assert.equal(browser.jar.filter((c) => c.name.startsWith('__Secure-gentian-sso-')).length, 0, 'the sign-in cookie is gone');

        // Opened again: no form, no credentials, a new session.
        browser.log.length = 0;
        const again = await browser.navigate(`https://${place.host}/`);
        assert.equal(new URL(again.url).pathname, '/signed-in');
        assert.ok(!browser.log.some((line) => line.includes('login-actions')), 'the realm asked for nothing: ' + browser.log.join(' -> '));
    });

    test(`${place.label}: the answer the realm posted is accepted once`, async () => {
        const browser = browserFor(place, { person: ANNA });
        await browser.navigate(`https://${place.host}/`, { credentials: { username: ANNA.email, password: ANNA.password } });
        const replay = await browser.request('POST', `https://${place.host}/sso/acs`, { form: { SAMLResponse: browser.lastSamlResponse } });
        assert.equal(replay.status, 401);
    });
}

test('the person at the realm must be the person the front door admitted', async () => {
    const place = PLACES[0];
    const door = { person: ANNA };
    const browser = browserFor(place, door);
    await browser.navigate(`https://${place.host}/`, { credentials: { username: ANNA.email, password: ANNA.password } });
    // The front door now says Ben, the realm's cookie in this browser still says Anna.
    door.person = BEN;
    const res = await browser.navigate(`https://${place.host}/`);
    assert.equal(res.status, 403);
    assert.equal(new URL(res.url).pathname, '/sso/acs');
});

test('nobody begins a sign-in without the front door', async () => {
    const place = PLACES[0];
    const res = await setup.call('GET', `${place.sidecar.upstream}/sso/login`, { headers: { host: place.host } });
    assert.equal(res.status, 403);
});

test('an answer made for one app is refused by another app\'s sidecar', async () => {
    const [one, , other] = PLACES; // both in realm acme
    const browser = browserFor(one, { person: ANNA });
    await browser.navigate(`https://${one.host}/`, { credentials: { username: ANNA.email, password: ANNA.password } });
    const res = await setup.call('POST', `${other.sidecar.upstream}/sso/acs`, {
        headers: { host: other.host, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'SAMLResponse=' + encodeURIComponent(browser.lastSamlResponse),
    });
    assert.equal(res.status, 401);
});

test('an answer the sidecar did not ask for is refused', async () => {
    // Somebody else's request: the realm answers it, correctly signed and
    // addressed here, and the sidecar has never heard of it.
    const place = PLACES[0];
    const browser = browserFor(place, { person: ANNA });
    await browser.navigate(`https://${place.host}/`, { credentials: { username: ANNA.email, password: ANNA.password } });
    const zlib = require('node:zlib');
    const request = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_forged${Date.now()}" Version="2.0" IssueInstant="${new Date().toISOString()}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" AssertionConsumerServiceURL="https://${place.host}/sso/acs" Destination="${setup.IDP_BASE}/realms/${place.realm}/protocol/saml"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://${place.host}/sso</saml:Issuer></samlp:AuthnRequest>`;
    const url = `${setup.IDP_BASE}/realms/${place.realm}/protocol/saml?SAMLRequest=${encodeURIComponent(zlib.deflateRawSync(request).toString('base64'))}`;
    const res = await browser.navigate(url);
    assert.equal(new URL(res.url).pathname, '/sso/acs', browser.log.join(' -> '));
    assert.equal(res.status, 401);
});

test('the realm posts an answer to the registered address and to no other', async () => {
    const place = PLACES[0];
    const browser = browserFor(place, { person: ANNA });
    await browser.navigate(`https://${place.host}/`, { credentials: { username: ANNA.email, password: ANNA.password } });
    const zlib = require('node:zlib');
    const request = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_elsewhere${Date.now()}" Version="2.0" IssueInstant="${new Date().toISOString()}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" AssertionConsumerServiceURL="https://evil.example/collect" Destination="${setup.IDP_BASE}/realms/${place.realm}/protocol/saml"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://${place.host}/sso</saml:Issuer></samlp:AuthnRequest>`;
    const url = `${setup.IDP_BASE}/realms/${place.realm}/protocol/saml?SAMLRequest=${encodeURIComponent(zlib.deflateRawSync(request).toString('base64'))}`;
    const res = await browser.request('GET', url);
    assert.ok(res.status >= 400, `the realm answered ${res.status}`);
    assert.ok(!res.body.includes('SAMLResponse'), 'no assertion was issued');
});

test('the sidecar\'s log names nobody', async () => {
    for (const place of PLACES) {
        const logs = setup.logsOf(place.sidecar.name);
        assert.match(logs, /"event":"signed-in"/);
        assert.doesNotMatch(logs, /anna|ben@|Example|SAMLResponse/i);
    }
});
