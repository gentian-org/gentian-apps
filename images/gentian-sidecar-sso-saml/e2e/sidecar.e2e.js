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
const { refusedSignOuts } = require('./lib/signout');

const ANNA = { email: 'anna@acme.e2e.test', firstName: 'Anna', lastName: "O'Example", password: 'pw-anna-e2e', subject: 'sub-anna', name: "Anna O'Example" };
const BEN = { email: 'ben@acme.e2e.test', firstName: 'Ben', lastName: 'Example', password: 'pw-ben-e2e', subject: 'sub-ben', name: 'Ben Example' };
// Holds roles of his own in one test, which are not taken away again.
const CARL = { email: 'carl@acme.e2e.test', firstName: 'Carl', lastName: 'Example', password: 'pw-carl-e2e', subject: 'sub-carl', name: 'Carl Example' };

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
    for (const realm of ['acme', 'user']) await setup.ensureRealm(kc, realm, [ANNA, BEN, CARL]);
    for (const [i, place] of PLACES.entries()) {
        await setup.ensureSidecarClient(kc, place.realm, place.host, { logoutUrl: setup.logoutUrlOf(`sso-e2e-sidecar-${i}`) });
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
    for (const name of started) setup.removeSidecar(name);
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

// Who administers the app: the realm says it, in the answer it signs, for a
// member of the tenant's app administrators' group and for nobody else.

function saysAdmin(browser, host) {
    return Buffer.from(browser.cookie(host, 'e2e_session').value, 'base64url').toString().split('|')[2];
}

async function open(place, person, extra) {
    const browser = browserFor(place, { person });
    const res = await browser.navigate(`https://${place.host}/`, { credentials: { username: person.email, password: person.password }, ...(extra || {}) });
    assert.equal(new URL(res.url).pathname, '/signed-in', browser.log.join(' -> '));
    return browser;
}

test('a person who holds the App Admin role is told to the handler as the app\'s administrator, and nobody else is', async () => {
    const place = PLACES[0];
    await setup.setAppAdmin(kc, place.realm, ANNA.email, true);
    try {
        const anna = await open(place, ANNA);
        assert.equal(saysAdmin(anna, place.host), 'true');
        // The one role of this client, and nothing else the realm knows
        // about her: no group, no other role.
        assert.deepEqual(setup.rolesIn(anna.lastSamlResponse), [`${setup.ROLE_ATTRIBUTE}=${setup.APP_ADMIN_ROLE}`]);

        const ben = await open(place, BEN);
        assert.equal(saysAdmin(ben, place.host), 'false');
        assert.deepEqual(setup.rolesIn(ben.lastSamlResponse), []);
    } finally {
        await setup.setAppAdmin(kc, place.realm, ANNA.email, false);
    }
});

test('the role is the tenant\'s in its own realm: the same person is no administrator where she does not hold it', async () => {
    const [acme, single] = PLACES; // realms acme and user
    await setup.setAppAdmin(kc, acme.realm, ANNA.email, true);
    try {
        assert.equal(saysAdmin(await open(single, ANNA), single.host), 'false');
        assert.equal(saysAdmin(await open(acme, ANNA), acme.host), 'true');
    } finally {
        await setup.setAppAdmin(kc, acme.realm, ANNA.email, false);
    }
});

test('withdrawing the role takes effect at the next sign-in', async () => {
    const place = PLACES[0];
    await setup.setAppAdmin(kc, place.realm, ANNA.email, true);
    const browser = await open(place, ANNA);
    assert.equal(saysAdmin(browser, place.host), 'true');
    await setup.setAppAdmin(kc, place.realm, ANNA.email, false);
    // The same browser, still signed in at the realm: asked nothing, and no
    // administrator any more.
    await browser.navigate(`https://${place.host}/`);
    assert.equal(saysAdmin(browser, place.host), 'false');
});

test('the tenant\'s administrator is not the app\'s administrator for being that', async () => {
    const place = PLACES[0];
    const admins = await setup.groupId(kc, place.realm, `gentian:tenant:${place.realm}:admins`);
    const ben = await setup.userId(kc, place.realm, BEN.email);
    await kc.admin('PUT', `/realms/${place.realm}/users/${ben}/groups/${admins}`);
    try {
        assert.equal(saysAdmin(await open(place, BEN), place.host), 'false');
    } finally {
        await kc.admin('DELETE', `/realms/${place.realm}/users/${ben}/groups/${admins}`);
    }
});

test('a role of the same name anywhere else in the realm makes no administrator', async () => {
    const place = PLACES[0];
    const other = PLACES[2]; // another app's sidecar in the same realm
    const carl = await setup.userId(kc, place.realm, CARL.email);
    // A realm role of that name, held directly.
    await kc.admin('POST', `/realms/${place.realm}/roles`, { name: setup.APP_ADMIN_ROLE });
    const realmRole = JSON.parse((await kc.admin('GET', `/realms/${place.realm}/roles/${setup.APP_ADMIN_ROLE}`)).body);
    await kc.admin('POST', `/realms/${place.realm}/users/${carl}/role-mappings/realm`, [{ id: realmRole.id, name: realmRole.name }]);
    // The role of another app's client, held directly: Carl administers that
    // app and not this one.
    const clients = JSON.parse((await kc.admin('GET', `/realms/${place.realm}/clients?clientId=${encodeURIComponent(`https://${other.host}/sso`)}`)).body);
    const otherRole = JSON.parse((await kc.admin('GET', `/realms/${place.realm}/clients/${clients[0].id}/roles/${setup.APP_ADMIN_ROLE}`)).body);
    await kc.admin('POST', `/realms/${place.realm}/users/${carl}/role-mappings/clients/${clients[0].id}`, [{ id: otherRole.id, name: otherRole.name }]);
    assert.equal(saysAdmin(await open(place, CARL), place.host), 'false');
    assert.equal(saysAdmin(await open(other, CARL), other.host), 'true');
});

test('nothing a browser sends makes an administrator', async () => {
    const place = PLACES[0];
    const claims = { 'x-gentian-app-admin': 'true', 'x-gentian-roles': setup.APP_ADMIN_ROLE, role: setup.APP_ADMIN_ROLE };
    const browser = browserFor(place, { person: BEN });
    // Every request of the sign-in carries the claims, and a cookie of the
    // attribute's name is in the jar.
    const request = browser.request.bind(browser);
    browser.request = (method, url, options = {}) => request(method, url, { ...options, headers: { ...(options.headers || {}), ...claims } });
    browser.jar.push({ host: place.host, name: 'Role', value: setup.APP_ADMIN_ROLE, path: '/', sameSite: 'None', httpOnly: false, secure: true, raw: '' });
    const res = await browser.navigate(`https://${place.host}/?appAdmin=true`, { credentials: { username: BEN.email, password: BEN.password } });
    assert.equal(new URL(res.url).pathname, '/signed-in', browser.log.join(' -> '));
    assert.equal(saysAdmin(browser, place.host), 'false');

    // And the realm's own answer with the attribute put in afterwards is no
    // answer at all.
    const fresh = browserFor(place, { person: BEN });
    const login = await fresh.request('GET', `https://${place.host}/sso/login`);
    let page = await fresh.request('GET', login.headers.location, { fromHost: place.host });
    for (let i = 0; i < 6 && !/NAME="SAMLResponse"/i.test(page.body); i++) {
        const form = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(page.body);
        page = form
            ? await fresh.request('POST', form[1].replace(/&amp;/g, '&'), { form: { username: BEN.email, password: BEN.password }, fromHost: setup.IDP_HOST })
            : await fresh.request('GET', new URL(page.headers.location, page.url).toString(), { fromHost: setup.IDP_HOST });
    }
    const answer = /NAME="SAMLResponse"\s+VALUE="([^"]+)"/i.exec(page.body)[1];
    const xml = Buffer.from(answer, 'base64').toString('utf8');
    const prefix = /<(\w+):AuthnStatement\b/.exec(xml)[1];
    const forged = xml.replace(new RegExp(`</${prefix}:AuthnStatement>`),
        `</${prefix}:AuthnStatement><${prefix}:AttributeStatement><${prefix}:Attribute Name="${setup.ROLE_ATTRIBUTE}">` +
        `<${prefix}:AttributeValue>${setup.APP_ADMIN_ROLE}</${prefix}:AttributeValue></${prefix}:Attribute></${prefix}:AttributeStatement>`);
    assert.notEqual(forged, xml);
    const posted = await fresh.request('POST', `https://${place.host}/sso/acs`,
        { form: { SAMLResponse: Buffer.from(forged, 'utf8').toString('base64') }, fromHost: setup.IDP_HOST });
    assert.equal(posted.status, 401);
    assert.equal(fresh.cookie(place.host, 'e2e_session'), undefined);
});

// Signing out. The realm tells the sidecar, inside the network, and the
// sidecar tells the handler whom.

function timesSignedOut(browser, host) {
    return Number(Buffer.from(browser.cookie(host, 'e2e_session').value, 'base64url').toString().split('|')[3]);
}

for (const place of PLACES) {
    test(`${place.label}: a sign-out at the realm reaches the handler, for that person and nobody else`, async () => {
        const before = (await setup.signOutPosts(place.sidecar)).length;
        const anna = await open(place, ANNA);
        const ben = await open(place, BEN);
        const annaBefore = timesSignedOut(anna, place.host);
        const benBefore = timesSignedOut(ben, place.host);

        await setup.signOutAtRealm(anna, place.realm);
        const posts = await setup.waitForSignOut(place.sidecar, before + 1);
        assert.equal(posts.length, before + 1, 'the realm told the sidecar once');
        const post = posts[posts.length - 1];
        assert.equal(post.status, 200);
        assert.equal(post.host, place.sidecar.service.host, 'under the sidecar\'s name inside the network');
        assert.equal(post.path, '/sso/logout');

        // Anna is asked for her password again: the realm session is over.
        const again = await anna.navigate(`https://${place.host}/`);
        assert.match(again.body, /kc-form-login/, 'the realm asks who she is');
        const back = await open(place, ANNA);
        assert.equal(timesSignedOut(back, place.host), annaBefore + 1);

        // Ben was not signed out: the realm asks him nothing, and the
        // handler was not told about him.
        ben.log.length = 0;
        await ben.navigate(`https://${place.host}/`);
        assert.ok(!ben.log.some((line) => line.includes('login-actions')), ben.log.join(' -> '));
        assert.equal(timesSignedOut(ben, place.host), benBefore);
    });
}

test('a sign-out the realm did not send, or sent before, reaches no handler', async () => {
    const place = PLACES[0];
    const ben = await open(place, BEN);
    const benBefore = timesSignedOut(ben, place.host);
    // The realm's own request, to have one to present again.
    const anna = await open(place, ANNA);
    const posted = (await setup.signOutPosts(place.sidecar)).length;
    await setup.signOutAtRealm(anna, place.realm);
    await setup.waitForSignOut(place.sidecar, posted + 1);

    await refusedSignOuts(place.sidecar, { realm: place.realm, email: BEN.email });
    await ben.navigate(`https://${place.host}/`);
    assert.equal(timesSignedOut(ben, place.host), benBefore);
});

test('a sign-out for one app\'s sidecar is refused by another\'s', async () => {
    const [one, , other] = PLACES; // both in realm acme
    const anna = await open(one, ANNA);
    const posted = (await setup.signOutPosts(one.sidecar)).length;
    await setup.signOutAtRealm(anna, one.realm);
    const posts = await setup.waitForSignOut(one.sidecar, posted + 1);
    const res = await setup.postSignOut(other.sidecar, null, { body: posts[posts.length - 1].body });
    assert.equal(res.status, 401);
});

test('the sign-out path does not answer under the app\'s public name', async () => {
    const place = PLACES[0];
    const res = await setup.call('POST', `${place.sidecar.upstream}/sso/logout`, {
        headers: { host: place.host, 'content-type': 'application/x-www-form-urlencoded' }, body: 'SAMLRequest=x',
    });
    assert.equal(res.status, 404);
});

test('a handler with no sign-out handling: the realm is answered and the sign-out goes through', async () => {
    const host = 'old.acme.e2e.test';
    const name = 'sso-e2e-sidecar-old';
    await setup.ensureSidecarClient(kc, 'acme', host, { logoutUrl: setup.logoutUrlOf(name) });
    const sidecar = setup.startSidecar({ name, host, realm: 'acme', kc, handlerFile: path.join(__dirname, 'handlers', 'no-logout.js') });
    started.push(name);
    await setup.sidecarReady(sidecar);
    const place = { host, realm: 'acme', sidecar };
    const anna = await open(place, ANNA);
    await setup.signOutAtRealm(anna, 'acme');
    const posts = await setup.waitForSignOut(sidecar, 1);
    assert.equal(posts[0].status, 200);
    assert.match(setup.logsOf(name), /"event":"no-sign-out-handling"/);
    const again = await anna.navigate(`https://${host}/`);
    assert.match(again.body, /kc-form-login/);
});

test('a sidecar that is told no sign-out address: the realm\'s sign-out goes through all the same', async () => {
    // The client names an address and nothing answers there as a sign-out:
    // what a cluster has while its sidecar is the build before this one.
    const host = 'older.acme.e2e.test';
    const name = 'sso-e2e-sidecar-older';
    await setup.ensureSidecarClient(kc, 'acme', host, { logoutUrl: `http://${name}:8081/sso/logout` });
    const sidecar = setup.startSidecar({ name, host, realm: 'acme', kc, logout: false, handlerFile: path.join(__dirname, 'handlers', 'echo.js') });
    started.push(name);
    await setup.sidecarReady(sidecar);
    const anna = await open({ host, realm: 'acme', sidecar }, ANNA);
    await setup.signOutAtRealm(anna, 'acme');
    const again = await anna.navigate(`https://${host}/`);
    assert.match(again.body, /kc-form-login/, 'she is signed out at the realm');
});

test('the sidecar\'s log names nobody', async () => {
    for (const place of PLACES) {
        const logs = setup.logsOf(place.sidecar.name);
        assert.match(logs, /"event":"signed-in"/);
        assert.match(logs, /"event":"signed-out"/);
        assert.doesNotMatch(logs, /anna|ben@|carl|Example|SAMLResponse/i);
    }
});
