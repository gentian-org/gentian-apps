'use strict';

const { DOMParser } = require('@xmldom/xmldom');
const xpath = require('xpath');

// The identity provider's signing certificates, read from the realm's SAML
// descriptor inside the cluster.
//
// Read from the descriptor rather than copied into the configuration, so a
// change of the realm's key is picked up without touching the sidecar. Until
// a certificate is known every sign-in is refused: an answer that cannot be
// checked is not an answer.

const SIGNING_CERTS =
    "//*[local-name()='IDPSSODescriptor']/*[local-name()='KeyDescriptor'][not(@use) or @use='signing']" +
    "//*[local-name()='X509Certificate']";

function certificatesOf(descriptorXml) {
    const problems = [];
    const doc = new DOMParser({
        errorHandler: { warning() {}, error: (m) => problems.push(m), fatalError: (m) => problems.push(m) },
    }).parseFromString(descriptorXml, 'text/xml');
    if (problems.length > 0 || !doc || !doc.documentElement) {
        throw new Error('the descriptor is not XML');
    }
    const certs = [];
    for (const node of xpath.select(SIGNING_CERTS, doc)) {
        const body = (node.textContent || '').replace(/\s+/g, '');
        if (/^[A-Za-z0-9+/]+=*$/.test(body) && !certs.includes(body)) certs.push(body);
    }
    if (certs.length === 0) throw new Error('the descriptor names no signing certificate');
    return certs;
}

function toPem(cert) {
    return `-----BEGIN CERTIFICATE-----\n${cert.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

class Certificates {
    constructor({ descriptorUrl, fetchImpl, now, minRefreshMs = 30000 }) {
        this.descriptorUrl = descriptorUrl;
        this.fetchImpl = fetchImpl || fetch;
        this.now = now || (() => Date.now());
        this.minRefreshMs = minRefreshMs;
        this.certs = null;
        this.loadedAt = 0;
        this.loading = null;
    }

    known() {
        return this.certs;
    }

    async load() {
        if (this.loading) return this.loading;
        this.loading = (async () => {
            const res = await this.fetchImpl(this.descriptorUrl, {
                redirect: 'error',
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) throw new Error(`the descriptor answered ${res.status}`);
            const certs = certificatesOf(await res.text());
            const changed = JSON.stringify(certs) !== JSON.stringify(this.certs);
            this.certs = certs;
            this.loadedAt = this.now();
            return changed;
        })();
        try {
            return await this.loading;
        } finally {
            this.loading = null;
        }
    }

    // Certificates, loading them if none is known yet. Throws when there is
    // still none.
    async get() {
        if (!this.certs) await this.load();
        return this.certs;
    }

    // Reads the descriptor again unless it was read a moment ago, and says
    // whether the certificates are different now. For a signature that did
    // not verify: the realm's key may have been changed.
    async refreshIfStale() {
        if (this.now() - this.loadedAt < this.minRefreshMs) return false;
        try {
            return await this.load();
        } catch {
            return false;
        }
    }
}

module.exports = { Certificates, certificatesOf, toPem };
