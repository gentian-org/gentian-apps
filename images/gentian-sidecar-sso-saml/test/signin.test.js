'use strict';

const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const { makeIdp, buildResponse, makeSignIn, begin, iso, roleAttribute } = require('./helpers');

let idp;
let other;
before(() => {
    idp = makeIdp();
    other = makeIdp();
});

async function refused(promise, code) {
    await assert.rejects(promise, (err) => {
        assert.equal(err.code, code, `refused as "${err.code}" (${err.detail || ''}), expected "${code}"`);
        return true;
    });
}

// One sign-in with one thing changed in what the realm posts back.
async function attempt(responseOptions, { person, cookies, configOverrides } = {}) {
    const { signIn, config } = makeSignIn(idp, configOverrides);
    const started = await begin(signIn, person);
    const samlResponse = buildResponse(idp, config, { requestId: started.requestId, ...responseOptions });
    return signIn.complete({ samlResponse, cookies: cookies || started.cookies });
}

test('a signed answer to a request this sidecar sent signs the person in', async () => {
    const result = await attempt({});
    assert.deepEqual({ ...result.person }, { email: 'anna@acme.example.org', name: 'Anna Example', appAdmin: false });
    assert.equal(result.sessionSeconds, 3600);
});

test('the request sent to the realm names this sidecar and its own address', async () => {
    const { signIn, config } = makeSignIn(idp);
    const started = await begin(signIn);
    assert.equal(started.url.origin + started.url.pathname, config.idpSsoUrl);
    assert.match(started.request, new RegExp(`AssertionConsumerServiceURL="${config.acsUrl}"`));
    assert.match(started.request, new RegExp(`<saml:Issuer[^>]*>${config.entityId}</saml:Issuer>`));
    assert.match(started.requestId, /^_[0-9a-f]{40}$/);
    assert.match(started.cookie.name, /^__Secure-gentian-sso-[0-9a-f]{16}$/);
    const again = await begin(signIn);
    assert.notEqual(again.requestId, started.requestId);
});

test('an answer nobody signed is refused', async () => {
    await refused(attempt({ signResponse: false, signAssertion: false }), 'signature');
});

test('a signed assertion inside an unsigned response is refused', async () => {
    await refused(attempt({ signResponse: false }), 'signature');
});

test('a signed response around an unsigned assertion is refused', async () => {
    await refused(attempt({ signAssertion: false }), 'invalid');
});

test('an answer signed with a key that is not the realm\'s is refused', async () => {
    await refused(attempt({ responseKey: other.key, assertionKey: other.key }), 'signature');
    await refused(attempt({ assertionKey: other.key }), 'invalid');
});

test('an answer changed after it was signed is refused', async () => {
    await refused(attempt({
        afterSigning: (xml) => xml.replace('anna@acme.example.org', 'boss@acme.example.org'),
    }), 'signature');
});

test('an answer made for another audience is refused', async () => {
    await refused(attempt({ audience: 'https://other.acme.example.org/sso' }), 'invalid');
});

test('an answer addressed to another place is refused', async () => {
    await refused(attempt({ destination: 'https://other.acme.example.org/sso/acs' }), 'destination');
    await refused(attempt({ recipient: 'https://other.acme.example.org/sso/acs' }), 'recipient');
});

test('an answer from another realm is refused', async () => {
    await refused(attempt({ issuer: 'https://id.example.org/auth/realms/other' }), 'issuer');
});

test('an answer past its validity period is refused, and one not yet valid', async () => {
    await refused(attempt({ notOnOrAfter: iso(-60) }), 'invalid');
    await refused(attempt({ notBefore: iso(120), notOnOrAfter: iso(240) }), 'invalid');
});

test('an answer to a request this sidecar did not send is refused', async () => {
    await refused(attempt({ requestId: '_somebody_elses_request' }), 'in-response-to');
    await refused(attempt({ requestId: null, subjectInResponseTo: '' }), 'unsolicited');
});

test('an assertion that answers another request than its response is refused', async () => {
    await refused(attempt({ subjectInResponseTo: '_another_request' }), 'invalid');
});

test('the same answer is accepted once', async () => {
    const { signIn, config } = makeSignIn(idp);
    const started = await begin(signIn);
    const samlResponse = buildResponse(idp, config, { requestId: started.requestId });
    await signIn.complete({ samlResponse, cookies: started.cookies });
    await refused(signIn.complete({ samlResponse, cookies: started.cookies }), 'in-response-to');
});

test('an assertion presented before is refused for a second request too', async () => {
    const { signIn, config } = makeSignIn(idp);
    const first = await begin(signIn);
    await signIn.complete({
        samlResponse: buildResponse(idp, config, { requestId: first.requestId, assertionId: '_one_assertion' }),
        cookies: first.cookies,
    });
    const second = await begin(signIn);
    await refused(signIn.complete({
        samlResponse: buildResponse(idp, config, { requestId: second.requestId, assertionId: '_one_assertion' }),
        cookies: second.cookies,
    }), 'replay');
});

test('an answer that arrives more than five minutes after the request is refused', async () => {
    const { signIn, config, clock } = makeSignIn(idp);
    const started = await begin(signIn);
    clock.offset = 5 * 60 * 1000 + 1000;
    await refused(signIn.complete({
        samlResponse: buildResponse(idp, config, { requestId: started.requestId }),
        cookies: started.cookies,
    }), 'in-response-to');
});

test('an answer posted by another browser than the one that asked is refused', async () => {
    await refused(attempt({}, { cookies: {} }), 'other-browser');
    const { signIn, config } = makeSignIn(idp);
    const mine = await begin(signIn);
    const theirs = await begin(signIn);
    const wrong = { [mine.cookie.name]: theirs.cookie.value };
    await refused(signIn.complete({
        samlResponse: buildResponse(idp, config, { requestId: mine.requestId }),
        cookies: wrong,
    }), 'other-browser');
});

test('a refused answer spends the request it answered', async () => {
    const { signIn, config } = makeSignIn(idp);
    const started = await begin(signIn);
    const samlResponse = buildResponse(idp, config, { requestId: started.requestId });
    await refused(signIn.complete({ samlResponse, cookies: {} }), 'other-browser');
    await refused(signIn.complete({ samlResponse, cookies: started.cookies }), 'in-response-to');
});

test('an answer about another person than the front door admitted is refused', async () => {
    await refused(attempt({ email: 'ben@acme.example.org' }), 'other-person');
});

test('the person\'s address is compared without regard to case', async () => {
    const result = await attempt({ email: 'Anna@Acme.Example.org' }, { person: { email: 'ANNA@acme.example.org', name: '' } });
    assert.equal(result.person.email, 'anna@acme.example.org');
});

test('a name identifier that is not an e-mail address is refused', async () => {
    await refused(attempt({ nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent' }), 'name-id');
    await refused(attempt({ email: 'not-an-address' }), 'name-id');
});

test('a comment slipped into the signed address does not shorten it', async () => {
    // The signature does not cover comments. A reader that stopped at one
    // would take "anna@acme.example.org" out of an address the realm issued
    // to somebody at another domain.
    const promise = attempt({
        email: 'anna@acme.example.org.attacker.example',
        afterSigning: (xml) => xml.replace('anna@acme.example.org.attacker.example', 'anna@acme.example.org<!-- -->.attacker.example'),
    });
    await assert.rejects(promise, (err) => ['other-person', 'signature', 'invalid'].includes(err.code));
});

test('a response carrying two assertions is refused', async () => {
    await assert.rejects(attempt({ secondAssertion: true }), (err) => ['assertions', 'invalid'].includes(err.code));
});

test('a response that reports a failure is refused', async () => {
    await refused(attempt({ status: 'urn:oasis:names:tc:SAML:2.0:status:Responder' }), 'status');
});

test('a document type declaration is refused before anything is parsed', async () => {
    await refused(attempt({
        afterSigning: (xml) => '<!DOCTYPE r [<!ENTITY x "y">]>' + xml,
    }), 'doctype');
});

test('what is not a SAML response is refused', async () => {
    const { signIn } = makeSignIn(idp);
    await refused(signIn.complete({ samlResponse: '', cookies: {} }), 'no-response');
    await refused(signIn.complete({ samlResponse: '<<<not base64>>>', cookies: {} }), 'not-base64');
    await refused(signIn.complete({ samlResponse: Buffer.from('not xml <').toString('base64'), cookies: {} }), 'not-xml');
    await refused(signIn.complete({ samlResponse: 'A'.repeat(600 * 1024), cookies: {} }), 'too-large');
});

test('a session never outlasts the realm session it came from, nor the ceiling', async () => {
    const short = await attempt({ sessionNotOnOrAfter: iso(600) });
    assert.ok(short.sessionSeconds > 590 && short.sessionSeconds <= 600, String(short.sessionSeconds));
    const capped = await attempt({ sessionNotOnOrAfter: iso(36000) }, { configOverrides: { SSO_SESSION_MAX_SECONDS: '900' } });
    assert.equal(capped.sessionSeconds, 900);
    const none = await attempt({ sessionNotOnOrAfter: '' });
    assert.equal(none.sessionSeconds, 3600);
    await refused(attempt({ sessionNotOnOrAfter: iso(-10) }), 'session-over');
});

test('a changed realm key is picked up when a signature does not verify', async () => {
    const { signIn, config, certificates } = makeSignIn(idp);
    const started = await begin(signIn);
    certificates.next = [other.cert];
    const samlResponse = buildResponse(other, config, { requestId: started.requestId });
    const result = await signIn.complete({ samlResponse, cookies: started.cookies });
    assert.equal(result.person.email, 'anna@acme.example.org');
});

test('no sign-in begins or completes while no certificate is known', async () => {
    const { signIn, config, certificates } = makeSignIn(idp);
    const started = await begin(signIn);
    certificates.get = async () => { throw new Error('unreachable'); };
    await assert.rejects(signIn.begin({ email: 'anna@acme.example.org', name: '' }));
    await refused(signIn.complete({
        samlResponse: buildResponse(idp, config, { requestId: started.requestId }),
        cookies: started.cookies,
    }), 'no-certificate');
});

// Who administers the app. The realm says it in the assertion it signs, and
// nothing else is read.

test('a person the realm lists the app administrator\'s role for is one', async () => {
    const result = await attempt({ attributes: roleAttribute(['gentian-app-admin']) });
    assert.equal(result.person.appAdmin, true);
    // Among other roles, and whichever way the realm groups the values.
    const among = await attempt({ attributes: roleAttribute(['something-else', 'gentian-app-admin']) });
    assert.equal(among.person.appAdmin, true);
    const apart = await attempt({ attributes: roleAttribute(['something-else']) + roleAttribute(['gentian-app-admin']) });
    assert.equal(apart.person.appAdmin, true);
});

test('without the attribute nobody is an administrator', async () => {
    assert.equal((await attempt({})).person.appAdmin, false);
    assert.equal((await attempt({ attributes: roleAttribute([]) })).person.appAdmin, false);
});

test('another value, or the value under another name, makes no administrator', async () => {
    for (const roles of [['app-admin'], ['admin'], ['true'], ['Gentian-App-Admin'], [' gentian-app-admin'], ['gentian-app-admin '],
        ['gentian-app-admins'], ['gentian-app-admin,x'], ['']]) {
        const result = await attempt({ attributes: roleAttribute(roles) });
        assert.equal(result.person.appAdmin, false, JSON.stringify(roles));
    }
    for (const name of ['role', 'Roles', 'gentianAppAdmin', 'appAdmin', 'groups', 'memberOf']) {
        const result = await attempt({ attributes: roleAttribute(['gentian-app-admin'], name) });
        assert.equal(result.person.appAdmin, false, name);
    }
});

test('the attribute counts only as the assertion\'s own, not inside something else it carries', async () => {
    const real = roleAttribute(['gentian-app-admin']);
    // Carried as the value of another attribute.
    const nested = '<saml:AttributeStatement><saml:Attribute Name="note"><saml:AttributeValue>' +
        real + '</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>';
    assert.equal((await attempt({ attributes: nested })).person.appAdmin, false);
    // An attribute outside an attribute statement.
    const loose = '<saml:Advice>' + real + '</saml:Advice>';
    assert.equal((await attempt({ attributes: loose })).person.appAdmin, false);
    // Elements of the same names in another namespace.
    const foreign = real.replace(/saml:/g, 'x:').replace('<x:AttributeStatement>', '<x:AttributeStatement xmlns:x="urn:example:not-saml">');
    assert.equal((await attempt({ attributes: foreign })).person.appAdmin, false);
});

test('the attribute added to an answer after the realm signed it gives nothing: the answer is refused', async () => {
    const forged = roleAttribute(['gentian-app-admin']);
    // Into the signed assertion.
    await refused(attempt({ afterSigning: (xml) => xml.replace('</saml:AuthnStatement>', '</saml:AuthnStatement>' + forged) }), 'signature');
    // Beside the assertion, in the response.
    await refused(attempt({ afterSigning: (xml) => xml.replace('</samlp:Response>', forged + '</samlp:Response>') }), 'signature');
    // In an assertion of its own, unsigned, beside the signed one.
    await refused(attempt({
        afterSigning: (xml) => xml.replace('</samlp:Response>',
            '<saml:Assertion ID="_forged" Version="2.0">' + forged + '</saml:Assertion></samlp:Response>'),
    }), 'signature');
});

test('the attribute in an assertion the realm did not sign gives nothing, whoever signed the response', async () => {
    await refused(attempt({ signAssertion: false, attributes: roleAttribute(['gentian-app-admin']) }), 'invalid');
    await refused(attempt({ assertionKey: other.key, attributes: roleAttribute(['gentian-app-admin']) }), 'invalid');
});
