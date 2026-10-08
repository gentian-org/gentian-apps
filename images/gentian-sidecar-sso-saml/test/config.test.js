'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { loadConfig } = require('../lib/config');
const { loadHandler } = require('../lib/handler');
const { certificatesOf, Certificates } = require('../lib/idp');
const { ENV } = require('./helpers');

test('every address is given, none is assumed', () => {
    for (const name of Object.keys(ENV)) {
        const env = { ...ENV };
        delete env[name];
        assert.throws(() => loadConfig(env), new RegExp(name), name);
    }
});

test('the app\'s own address and the realm\'s must be https', () => {
    assert.throws(() => loadConfig({ ...ENV, SSO_ACS_URL: 'http://app.acme.example.org/sso/acs' }), /https/);
    assert.throws(() => loadConfig({ ...ENV, SSO_IDP_SSO_URL: 'http://id.example.org/auth/realms/acme/protocol/saml' }), /https/);
    assert.throws(() => loadConfig({ ...ENV, SSO_ACS_URL: 'https://app.acme.example.org/sso/acs?x=1' }), /query/);
    assert.throws(() => loadConfig({ ...ENV, SSO_LOGIN_PATH: '/sso/acs' }), /same/);
});

test('addresses work for a tenant under the cluster, for a single tenant and for a domain of its own', () => {
    for (const [acs, issuer] of [
        ['https://auto.acme.example.org/sso/acs', 'https://id.example.org/auth/realms/acme'],
        ['https://auto.example.org/sso/acs', 'https://id.example.org/auth/realms/user'],
        ['https://auto.acme.com/sso/acs', 'https://id.example.org/auth/realms/acme'],
    ]) {
        const config = loadConfig({ ...ENV, SSO_ACS_URL: acs, SSO_ENTITY_ID: acs.replace('/acs', ''), SSO_IDP_ENTITY_ID: issuer, SSO_IDP_SSO_URL: issuer + '/protocol/saml' });
        assert.equal(config.acsUrl, acs);
        assert.equal(config.host, new URL(acs).host);
        assert.equal(config.idpEntityId, issuer);
    }
});

test('a session may be made shorter than an hour and never longer', () => {
    assert.equal(loadConfig(ENV).sessionMaxSeconds, 3600);
    assert.equal(loadConfig({ ...ENV, SSO_SESSION_MAX_SECONDS: '600' }).sessionMaxSeconds, 600);
    assert.equal(loadConfig({ ...ENV, SSO_SESSION_MAX_SECONDS: '86400' }).sessionMaxSeconds, 3600);
    assert.throws(() => loadConfig({ ...ENV, SSO_SESSION_MAX_SECONDS: '5' }), /minute/);
});

test('only the handler whose digest was given is loaded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sso-test-handler-'));
    try {
        const file = path.join(dir, 'handler.js');
        const source = 'module.exports = { onLogin: async () => ({ redirect: "/" }) };\n';
        fs.writeFileSync(file, source);
        const digest = crypto.createHash('sha256').update(source).digest('hex');
        assert.equal(typeof loadHandler(file, digest).onLogin, 'function');
        assert.throws(() => loadHandler(file, 'b'.repeat(64)), /not the one/);
        assert.throws(() => loadHandler(path.join(dir, 'missing.js'), digest), /cannot be read/);
        const empty = path.join(dir, 'empty.js');
        fs.writeFileSync(empty, 'module.exports = {};\n');
        assert.throws(() => loadHandler(empty, crypto.createHash('sha256').update('module.exports = {};\n').digest('hex')), /onLogin/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const DESCRIPTOR = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://id.example.org/auth/realms/acme">
<md:IDPSSODescriptor><md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>
 QUJDRA==
</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
<md:KeyDescriptor use="encryption"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>RU5DUg==</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
</md:IDPSSODescriptor></md:EntityDescriptor>`;

test('the signing certificates are read from the realm\'s descriptor, and only those', () => {
    assert.deepEqual(certificatesOf(DESCRIPTOR), ['QUJDRA==']);
    assert.throws(() => certificatesOf('<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"/>'), /no signing certificate/);
    assert.throws(() => certificatesOf('not xml <'), /not XML|no signing/);
});

test('no certificate is known until the descriptor has been read', async () => {
    let answer = { ok: false, status: 503, text: async () => '' };
    const certificates = new Certificates({ descriptorUrl: 'http://keycloak/descriptor', fetchImpl: async () => answer, minRefreshMs: 0 });
    assert.equal(certificates.known(), null);
    await assert.rejects(certificates.get(), /503/);
    answer = { ok: true, status: 200, text: async () => DESCRIPTOR };
    assert.deepEqual(await certificates.get(), ['QUJDRA==']);
    assert.equal(await certificates.refreshIfStale(), false, 'unchanged');
    answer = { ok: true, status: 200, text: async () => DESCRIPTOR.replace('QUJDRA==', 'TkVXSw==') };
    assert.equal(await certificates.refreshIfStale(), true, 'changed');
    assert.deepEqual(certificates.known(), ['TkVXSw==']);
});
