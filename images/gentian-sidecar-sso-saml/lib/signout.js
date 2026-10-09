'use strict';

const samlXml = require('@node-saml/node-saml/lib/xml');
const { DOMParser } = require('@xmldom/xmldom');
const { TtlStore } = require('./ttlstore');
const { toPem } = require('./idp');
const { Refusal, NAMEID_EMAIL } = require('./signin');

// A sign-out, told by the realm.
//
// When a person signs out at the platform, the realm ends its own session and
// tells every client that session was used at. For this sidecar that is a
// SAML LogoutRequest the realm posts, server to server, to the one address
// the platform registered for it: an address inside the cluster, which no
// browser reaches.
//
// What is accepted as such a request:
//
//   - signed by a certificate of the realm, over the request as a whole;
//   - a LogoutRequest, issued by the realm this sidecar was told about;
//   - addressed here: its Destination is this sidecar's own sign-out address;
//   - issued within the last two minutes, not in the future, and not past its
//     NotOnOrAfter where it carries one;
//   - not presented before;
//   - naming one person, by e-mail address, in clear;
//   - with no document type declaration.
//
// Anything else is refused and ends nobody's session. What a refusal can cost
// is small either way -- the worst a forged request could do is sign somebody
// out of one app -- but the checks are the ones the sign-in gets, because the
// same program makes both decisions.

const NS_PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol';
const NS_ASSERTION = 'urn:oasis:names:tc:SAML:2.0:assertion';

// How old a request may be. The realm posts it the moment the person signs
// out and does not send it again, so this only has to cover the two clocks.
const REQUEST_WINDOW_MS = 2 * 60 * 1000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_USED = 20000;
const MAX_SESSIONS = 50000;
const MAX_SESSION_INDEXES = 16;

function parse(xml) {
    const problems = [];
    const doc = new DOMParser({
        errorHandler: { warning() {}, error: (m) => problems.push(m), fatalError: (m) => problems.push(m) },
    }).parseFromString(xml, 'text/xml');
    if (problems.length > 0 || !doc || !doc.documentElement) return null;
    return doc;
}

function children(node, namespace, localName) {
    const out = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && child.namespaceURI === namespace && child.localName === localName) out.push(child);
    }
    return out;
}

function only(node, namespace, localName) {
    const found = children(node, namespace, localName);
    return found.length === 1 ? found[0] : null;
}

function text(node) {
    return node ? (node.textContent || '').trim() : '';
}

class SignOut {
    constructor({ config, certificates, now }) {
        this.config = config;
        this.certificates = certificates;
        this.now = now || (() => Date.now());
        this.used = new TtlStore({ maxEntries: MAX_USED, now: this.now });
        // The realm sessions this process signed somebody in from, and whom.
        this.sessions = new TtlStore({ maxEntries: MAX_SESSIONS, now: this.now });
    }

    // remember notes which person a realm session signed in here, so that a
    // sign-out naming that session and another person is told apart. Kept in
    // this process only: after a restart a sign-out is taken on the person
    // it names alone.
    remember(sessionIndex, email, seconds) {
        if (!sessionIndex || sessionIndex.length > 512) return;
        this.sessions.set(sessionIndex, email, this.now() + seconds * 1000);
    }

    // check answers whom a posted request signs out, or throws a Refusal.
    async check(samlRequest) {
        if (typeof samlRequest !== 'string' || samlRequest === '') throw new Refusal('no-request', 400);
        if (samlRequest.length > MAX_REQUEST_BYTES * 2) throw new Refusal('too-large', 413);
        if (!/^[A-Za-z0-9+/\s]+=*\s*$/.test(samlRequest)) throw new Refusal('not-base64', 400);
        const xml = Buffer.from(samlRequest, 'base64').toString('utf8');
        if (xml.length > MAX_REQUEST_BYTES) throw new Refusal('too-large', 413);
        if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Refusal('doctype', 400);
        const doc = parse(xml);
        if (!doc) throw new Refusal('not-xml', 400);

        let certs;
        try {
            certs = await this.certificates.get();
        } catch (err) {
            throw new Refusal('no-certificate', 503, err.message);
        }

        // The request as the realm signed it. Everything below is read from
        // these bytes, never from what was posted.
        let signed = this.verified(xml, doc, certs);
        if (!signed && (await this.certificates.refreshIfStale())) {
            certs = this.certificates.known();
            signed = this.verified(xml, doc, certs);
        }
        if (!signed) throw new Refusal('signature', 401);

        const request = parse(signed);
        const root = request && request.documentElement;
        if (!root || root.namespaceURI !== NS_PROTOCOL || root.localName !== 'LogoutRequest') {
            throw new Refusal('not-a-logout-request', 401);
        }
        if (root.getAttribute('Version') !== '2.0') throw new Refusal('version', 401);
        if (root.getAttribute('Destination') !== this.config.logoutUrl) throw new Refusal('destination', 401);
        if (text(only(root, NS_ASSERTION, 'Issuer')) !== this.config.idpEntityId) throw new Refusal('issuer', 401);

        const now = this.now();
        const skew = this.config.clockSkewMs;
        const issued = Date.parse(root.getAttribute('IssueInstant') || '');
        if (!Number.isFinite(issued)) throw new Refusal('issue-instant', 401);
        if (issued > now + skew) throw new Refusal('not-yet', 401);
        let until = issued + REQUEST_WINDOW_MS;
        if (root.hasAttribute('NotOnOrAfter')) {
            const notOnOrAfter = Date.parse(root.getAttribute('NotOnOrAfter') || '');
            if (!Number.isFinite(notOnOrAfter)) throw new Refusal('not-on-or-after', 401);
            until = Math.min(until, notOnOrAfter);
        }
        if (now >= until + skew) throw new Refusal('expired', 401);

        if (children(root, NS_ASSERTION, 'EncryptedID').length > 0 || children(root, NS_ASSERTION, 'BaseID').length > 0) {
            throw new Refusal('name-id', 401);
        }
        const nameId = only(root, NS_ASSERTION, 'NameID');
        if (!nameId || nameId.getAttribute('Format') !== NAMEID_EMAIL) throw new Refusal('name-id', 401);
        const email = text(nameId).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) throw new Refusal('name-id', 401);

        const indexes = children(root, NS_PROTOCOL, 'SessionIndex').map(text).filter((value) => value !== '');
        if (indexes.length > MAX_SESSION_INDEXES) throw new Refusal('session-index', 401);

        // One request is one sign-out.
        const id = root.getAttribute('ID') || '';
        if (!id || this.used.has(id)) throw new Refusal('replay', 401);
        if (!this.used.set(id, true, until + skew + 1000)) throw new Refusal('busy', 503);

        // A realm session this process signed somebody in from belongs to
        // that person. A request that names it for somebody else is not one
        // the realm writes.
        for (const index of indexes) {
            const known = this.sessions.get(index);
            if (known !== undefined && known !== email) throw new Refusal('other-person', 401);
        }
        for (const index of indexes) this.sessions.delete(index);

        return { person: Object.freeze({ email }), requestId: id };
    }

    verified(xml, doc, certs) {
        try {
            return samlXml.getVerifiedXml(xml, doc.documentElement, certs.map(toPem));
        } catch {
            return null;
        }
    }
}

module.exports = { SignOut, REQUEST_WINDOW_MS };
