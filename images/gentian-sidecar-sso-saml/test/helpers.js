'use strict';

// A stand-in identity provider for the tests: a key made for the run and the
// SAML responses a realm would post, built and signed here so that each test
// can get exactly one thing wrong.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { SignedXml } = require('xml-crypto');
const { loadConfig } = require('../lib/config');
const { SignIn } = require('../lib/signin');

const C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';

// makeIdp creates a signing key and a self-signed certificate for it. The key
// exists for one test run and is never written to the repository.
function makeIdp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sso-test-idp-'));
    try {
        execFileSync('openssl', [
            'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=test-idp',
            '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
        ], { stdio: 'ignore' });
        const key = fs.readFileSync(path.join(dir, 'key.pem'), 'utf8');
        const cert = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8')
            .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
        return { key, cert };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const ENV = {
    SSO_ENTITY_ID: 'https://app.acme.example.org/sso',
    SSO_ACS_URL: 'https://app.acme.example.org/sso/acs',
    SSO_IDP_ENTITY_ID: 'https://id.example.org/auth/realms/acme',
    SSO_IDP_SSO_URL: 'https://id.example.org/auth/realms/acme/protocol/saml',
    SSO_IDP_DESCRIPTOR_URL: 'http://keycloak.internal:8080/auth/realms/acme/protocol/saml/descriptor',
    SSO_REALM: 'acme',
    SSO_HANDLER_SHA256: 'a'.repeat(64),
};

function testConfig(overrides) {
    return loadConfig({ ...ENV, ...(overrides || {}) });
}

function sign(xml, id, key) {
    const sig = new SignedXml({
        privateKey: key,
        signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
        canonicalizationAlgorithm: C14N,
    });
    sig.addReference({
        xpath: `//*[@ID='${id}']`,
        digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
        transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', C14N],
    });
    sig.computeSignature(xml, {
        location: { reference: `//*[@ID='${id}']/*[local-name()='Issuer']`, action: 'after' },
    });
    return sig.getSignedXml();
}

function iso(offsetSeconds) {
    return new Date(Date.now() + offsetSeconds * 1000).toISOString();
}

// buildResponse is the response a realm posts for a sign-in request. Every
// field can be set wrong; signResponse and signAssertion choose what is
// signed, and with which key.
function buildResponse(idp, config, options) {
    const o = {
        requestId: '_request',
        email: 'anna@acme.example.org',
        issuer: config.idpEntityId,
        destination: config.acsUrl,
        recipient: config.acsUrl,
        audience: config.entityId,
        notBefore: iso(-30),
        notOnOrAfter: iso(60),
        sessionNotOnOrAfter: iso(36000),
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        status: 'urn:oasis:names:tc:SAML:2.0:status:Success',
        assertionId: '_assertion_' + crypto.randomBytes(8).toString('hex'),
        responseId: '_response_' + crypto.randomBytes(8).toString('hex'),
        signAssertion: true,
        signResponse: true,
        assertionKey: idp.key,
        responseKey: idp.key,
        subjectInResponseTo: undefined,
        secondAssertion: false,
        afterSigning: (xml) => xml,
        ...(options || {}),
    };
    const inResponseTo = o.requestId === null ? '' : ` InResponseTo="${o.requestId}"`;
    const subjectInResponseTo = o.subjectInResponseTo === undefined ? o.requestId : o.subjectInResponseTo;
    const session = o.sessionNotOnOrAfter ? ` SessionNotOnOrAfter="${o.sessionNotOnOrAfter}"` : '';
    const assertionOf = (id) =>
        `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${iso(0)}">` +
        `<saml:Issuer>${o.issuer}</saml:Issuer>` +
        `<saml:Subject><saml:NameID Format="${o.nameIdFormat}">${o.email}</saml:NameID>` +
        '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">' +
        `<saml:SubjectConfirmationData${subjectInResponseTo ? ` InResponseTo="${subjectInResponseTo}"` : ''} NotOnOrAfter="${o.notOnOrAfter}" Recipient="${o.recipient}"/>` +
        '</saml:SubjectConfirmation></saml:Subject>' +
        `<saml:Conditions NotBefore="${o.notBefore}" NotOnOrAfter="${o.notOnOrAfter}">` +
        `<saml:AudienceRestriction><saml:Audience>${o.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
        `<saml:AuthnStatement AuthnInstant="${iso(-5)}" SessionIndex="session::client"${session}>` +
        '<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified</saml:AuthnContextClassRef></saml:AuthnContext>' +
        '</saml:AuthnStatement></saml:Assertion>';

    let assertion = assertionOf(o.assertionId);
    if (o.signAssertion) assertion = sign(assertion, o.assertionId, o.assertionKey);
    let second = '';
    if (o.secondAssertion) {
        second = sign(assertionOf(o.assertionId + '_2'), o.assertionId + '_2', o.assertionKey);
    }
    let response =
        `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${o.responseId}" Version="2.0" IssueInstant="${iso(0)}" Destination="${o.destination}"${inResponseTo}>` +
        `<saml:Issuer>${o.issuer}</saml:Issuer>` +
        `<samlp:Status><samlp:StatusCode Value="${o.status}"/></samlp:Status>` +
        assertion + second +
        '</samlp:Response>';
    if (o.signResponse) response = sign(response, o.responseId, o.responseKey);
    return Buffer.from(o.afterSigning(response), 'utf8').toString('base64');
}

// A SignIn with its certificates given directly, and a clock that can be moved.
function makeSignIn(idp, configOverrides) {
    const config = testConfig(configOverrides);
    const clock = { offset: 0 };
    const certificates = {
        current: [idp.cert],
        next: null,
        known() { return this.current; },
        async get() { return this.current; },
        async refreshIfStale() {
            if (!this.next) return false;
            this.current = this.next;
            this.next = null;
            return true;
        },
    };
    const signIn = new SignIn({ config, certificates, now: () => Date.now() + clock.offset });
    return { config, signIn, certificates, clock };
}

// begin starts a sign-in the way the login path does and answers what the
// browser would carry to the identity provider and back.
async function begin(signIn, person) {
    const started = await signIn.begin(person || { email: 'anna@acme.example.org', name: 'Anna Example' });
    const url = new URL(started.redirectUrl);
    const request = zlib.inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest'), 'base64')).toString('utf8');
    const requestId = /\bID="([^"]+)"/.exec(request)[1];
    return { requestId, request, url, cookies: { [started.cookie.name]: started.cookie.value }, cookie: started.cookie };
}

module.exports = { makeIdp, testConfig, buildResponse, makeSignIn, begin, iso, sign, ENV };
