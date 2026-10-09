'use strict';

const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const { Refusal } = require('../lib/signin');
const { makeIdp, makeSignOut, buildLogoutRequest, iso, LOGOUT_URL } = require('./helpers');

let idp;
let other;

before(() => {
    idp = makeIdp();
    other = makeIdp();
});

async function refused(promise, code) {
    await assert.rejects(promise, (err) => {
        assert.ok(err instanceof Refusal, `expected a refusal, got ${err && err.stack}`);
        assert.equal(err.code, code);
        return true;
    });
}

test('a request the realm signed, addressed here, signs that person out', async () => {
    const { signOut, config } = makeSignOut(idp);
    const result = await signOut.check(buildLogoutRequest(idp, config, { email: 'Anna@Acme.Example.org' }));
    assert.deepEqual(result.person, { email: 'anna@acme.example.org' });
    assert.ok(Object.isFrozen(result.person));
});

test('a request without a session index is taken on the person it names', async () => {
    const { signOut, config } = makeSignOut(idp);
    const result = await signOut.check(buildLogoutRequest(idp, config, { sessionIndexes: [] }));
    assert.equal(result.person.email, 'anna@acme.example.org');
});

test('an unsigned request is refused', async () => {
    const { signOut, config } = makeSignOut(idp);
    await refused(signOut.check(buildLogoutRequest(idp, config, { signed: false })), 'signature');
});

test('a request signed by another key is refused', async () => {
    const { signOut, config } = makeSignOut(idp);
    await refused(signOut.check(buildLogoutRequest(idp, config, { key: other.key })), 'signature');
});

test('a request changed after it was signed is refused', async () => {
    const { signOut, config } = makeSignOut(idp);
    const request = buildLogoutRequest(idp, config, {
        afterSigning: (xml) => xml.replace('anna@acme.example.org', 'ben@acme.example.org'),
    });
    await refused(signOut.check(request), 'signature');
});

test('a signed request wrapped around another person is read as the realm signed it', async () => {
    // The signed request is kept, and an unsigned one for somebody else is
    // put around it: what is read is what was signed, or nothing.
    const { signOut, config } = makeSignOut(idp);
    const request = buildLogoutRequest(idp, config, {
        afterSigning: (xml) =>
            '<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ' +
            `Destination="${config.logoutUrl}" ID="ID_wrapper" IssueInstant="${iso(0)}" Version="2.0">` +
            `<saml:Issuer>${config.idpEntityId}</saml:Issuer>` +
            '<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">ben@acme.example.org</saml:NameID>' +
            `<samlp:Extensions>${xml}</samlp:Extensions></samlp:LogoutRequest>`,
    });
    await refused(signOut.check(request), 'signature');
});

test('a request addressed elsewhere is refused', async () => {
    const { signOut, config } = makeSignOut(idp);
    for (const destination of [
        'https://app.acme.example.org/sso/logout',
        'http://other-sign-in.tenant-acme.svc.cluster.local:8081/sso/logout',
        LOGOUT_URL + '/',
        '',
    ]) {
        await refused(signOut.check(buildLogoutRequest(idp, config, { destination })), 'destination');
    }
});

test('a request of another realm is refused', async () => {
    const { signOut, config } = makeSignOut(idp);
    const request = buildLogoutRequest(idp, config, { issuer: 'https://id.example.org/auth/realms/other' });
    await refused(signOut.check(request), 'issuer');
});

test('an old request is refused, and so is one from the future', async () => {
    const { signOut, config } = makeSignOut(idp);
    await refused(signOut.check(buildLogoutRequest(idp, config, { issueInstant: iso(-200) })), 'expired');
    await refused(signOut.check(buildLogoutRequest(idp, config, { issueInstant: iso(60) })), 'not-yet');
    await refused(signOut.check(buildLogoutRequest(idp, config, { issueInstant: 'yesterday' })), 'issue-instant');
});

test('a request past its NotOnOrAfter is refused', async () => {
    const { signOut, config } = makeSignOut(idp);
    await refused(signOut.check(buildLogoutRequest(idp, config, { notOnOrAfter: iso(-30) })), 'expired');
    await refused(signOut.check(buildLogoutRequest(idp, config, { notOnOrAfter: 'never' })), 'not-on-or-after');
    const result = await signOut.check(buildLogoutRequest(idp, config, { notOnOrAfter: iso(30) }));
    assert.equal(result.person.email, 'anna@acme.example.org');
});

test('a request goes stale while it waits', async () => {
    const { signOut, config, clock } = makeSignOut(idp);
    const request = buildLogoutRequest(idp, config);
    clock.offset = 3 * 60 * 1000;
    await refused(signOut.check(request), 'expired');
});

test('a request is taken once', async () => {
    const { signOut, config } = makeSignOut(idp);
    const request = buildLogoutRequest(idp, config);
    await signOut.check(request);
    await refused(signOut.check(request), 'replay');
});

test('something signed by the realm that is no sign-out is refused', async () => {
    const { signOut, config } = makeSignOut(idp);
    await refused(signOut.check(buildLogoutRequest(idp, config, { element: 'LogoutResponse' })), 'not-a-logout-request');
    await refused(signOut.check(buildLogoutRequest(idp, config, { element: 'AuthnRequest' })), 'not-a-logout-request');
    await refused(signOut.check(buildLogoutRequest(idp, config, { version: '1.1' })), 'version');
});

test('a request that names nobody, or not by e-mail address, or twice, is refused', async () => {
    const { signOut, config } = makeSignOut(idp);
    const email = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
    for (const options of [
        { nameId: '' },
        { nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent' },
        { email: 'not an address' },
        { nameId: `<saml:NameID Format="${email}">anna@acme.example.org</saml:NameID><saml:NameID Format="${email}">ben@acme.example.org</saml:NameID>` },
        { nameId: '<saml:EncryptedID>x</saml:EncryptedID>' },
    ]) {
        await refused(signOut.check(buildLogoutRequest(idp, config, options)), 'name-id');
    }
});

test('a document type declaration is refused before anything is parsed', async () => {
    const { signOut, config } = makeSignOut(idp);
    const request = buildLogoutRequest(idp, config, {
        afterSigning: (xml) => '<!DOCTYPE x [<!ENTITY e "anna@acme.example.org">]>' + xml,
    });
    await refused(signOut.check(request), 'doctype');
});

test('what is not a request at all is refused', async () => {
    const { signOut } = makeSignOut(idp);
    await refused(signOut.check(undefined), 'no-request');
    await refused(signOut.check(''), 'no-request');
    await refused(signOut.check('<xml>'), 'not-base64');
    await refused(signOut.check(Buffer.from('not xml <').toString('base64')), 'not-xml');
    await refused(signOut.check('A'.repeat(200 * 1024)), 'too-large');
});

test('a changed realm key is picked up once, and the request then accepted', async () => {
    const { signOut, config, certificates } = makeSignOut(idp);
    const request = buildLogoutRequest(other, config, { key: other.key });
    certificates.next = [other.cert];
    const result = await signOut.check(request);
    assert.equal(result.person.email, 'anna@acme.example.org');
});

test('a realm session that signed one person in here cannot sign another out', async () => {
    const { signOut, config } = makeSignOut(idp);
    signOut.remember('realm-session::client', 'anna@acme.example.org', 3600);
    const forBen = buildLogoutRequest(idp, config, { email: 'ben@acme.example.org', sessionIndexes: ['realm-session::client'] });
    await refused(signOut.check(forBen), 'other-person');
    // The session is still Anna's, and her own sign-out is taken.
    const forAnna = buildLogoutRequest(idp, config, { sessionIndexes: ['realm-session::client'] });
    assert.equal((await signOut.check(forAnna)).person.email, 'anna@acme.example.org');
});
