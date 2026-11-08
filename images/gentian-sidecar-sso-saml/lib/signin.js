'use strict';

const crypto = require('crypto');
const { SAML, ValidateInResponseTo } = require('@node-saml/node-saml');
const samlXml = require('@node-saml/node-saml/lib/xml');
const { DOMParser } = require('@xmldom/xmldom');
const { TtlStore } = require('./ttlstore');
const { toPem } = require('./idp');

// One sign-in, from the request sent to the identity provider to the answer
// it posts back.
//
// What is accepted as an answer:
//
//   - signed twice by a certificate of the realm: the response as a whole and
//     the assertion inside it;
//   - issued by the realm this sidecar was told about, and by no other;
//   - addressed here: its Destination and the assertion's Recipient are this
//     sidecar's own address, and its audience is this sidecar's own name;
//   - an answer to a request this process sent (InResponseTo), that has not
//     been answered before and is not older than five minutes;
//   - posted by the browser that was sent away with that request, which is
//     known by a cookie set at that moment;
//   - about the person the front door admitted when the request was sent;
//   - inside its validity period, carrying exactly one assertion, in clear,
//     that has not been presented before.
//
// Anything else is refused, and a refusal ends the request it answered: it
// cannot be tried again with a corrected message.
//
// One more thing is read from the assertion, and from nowhere else: whether
// the realm says this person administers the app (appAdminIn, below).

const NS_PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol';
const NS_ASSERTION = 'urn:oasis:names:tc:SAML:2.0:assertion';
const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
const NAMEID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
const METHOD_BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';

// How the realm says that a person administers this app: the platform gives
// the sidecar's client at the realm one role, grants it to the people who hold
// the platform's App Admin role, and has the realm list a person's roles at
// this client in the assertion (gentian-os,
// crossplane/compositions/app-default.yaml). A client the platform composed
// has that one role in scope and no other.
const ROLE_ATTRIBUTE = 'Role';
const APP_ADMIN_ROLE = 'gentian-app-admin';

const REQUEST_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 5000;
const MAX_USED = 20000;
const MAX_RESPONSE_BYTES = 256 * 1024;

class Refusal extends Error {
    constructor(code, status, detail) {
        super(code);
        this.code = code;
        this.status = status;
        // For the log only. Never the person's address or the assertion.
        this.detail = detail;
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function sameString(a, b) {
    const left = Buffer.from(sha256(a), 'hex');
    const right = Buffer.from(sha256(b), 'hex');
    return crypto.timingSafeEqual(left, right);
}

function cookieNameFor(requestId) {
    return '__Secure-gentian-sso-' + sha256(requestId).slice(0, 16);
}

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

// appAdminIn answers whether the assertion says the person administers the
// app. It is given the assertion as the realm signed it and reads nothing
// else: no header, no form field, no cookie, nothing the browser can write.
// The attribute has to be the assertion's own (a direct child of one of its
// attribute statements), under exactly this name, with exactly this value.
// Absent, under another name, with another value or encrypted: not an
// administrator.
function appAdminIn(assertion) {
    for (const statement of children(assertion, NS_ASSERTION, 'AttributeStatement')) {
        for (const attribute of children(statement, NS_ASSERTION, 'Attribute')) {
            if (attribute.getAttribute('Name') !== ROLE_ATTRIBUTE) continue;
            for (const value of children(attribute, NS_ASSERTION, 'AttributeValue')) {
                if ((value.textContent || '') === APP_ADMIN_ROLE) return true;
            }
        }
    }
    return false;
}

class SignIn {
    constructor({ config, certificates, now }) {
        this.config = config;
        this.certificates = certificates;
        this.now = now || (() => Date.now());
        this.pending = new TtlStore({ maxEntries: MAX_PENDING, now: this.now });
        this.used = new TtlStore({ maxEntries: MAX_USED, now: this.now });
    }

    samlOptions(certs, extra) {
        const { config } = this;
        return {
            idpCert: certs,
            issuer: config.entityId,
            audience: config.entityId,
            callbackUrl: config.acsUrl,
            entryPoint: config.idpSsoUrl,
            idpIssuer: config.idpEntityId,
            wantAuthnResponseSigned: true,
            wantAssertionsSigned: true,
            validateInResponseTo: ValidateInResponseTo.always,
            requestIdExpirationPeriodMs: REQUEST_TTL_MS,
            acceptedClockSkewMs: config.clockSkewMs,
            identifierFormat: NAMEID_EMAIL,
            disableRequestedAuthnContext: true,
            ...extra,
        };
    }

    // begin sends a browser to the identity provider, for a person the front
    // door has admitted. It answers where to send the browser and the cookie
    // that marks this browser as the one that was sent.
    async begin({ email, name }) {
        const certs = await this.certificates.get();
        const requestId = '_' + crypto.randomBytes(20).toString('hex');
        const nonce = crypto.randomBytes(32).toString('base64url');
        const createdAt = new Date(this.now()).toISOString();
        const kept = this.pending.set(
            requestId,
            { email: email.toLowerCase(), name, nonceHash: sha256(nonce), createdAt },
            this.now() + REQUEST_TTL_MS,
        );
        if (!kept) throw new Refusal('busy', 503);

        const saml = new SAML(this.samlOptions(certs, {
            generateUniqueId: () => requestId,
            // The request is remembered above, with what belongs to it.
            cacheProvider: { saveAsync: async () => null, getAsync: async () => null, removeAsync: async () => null },
        }));
        const redirectUrl = await saml.getAuthorizeUrlAsync('', undefined, {});
        return {
            redirectUrl,
            cookie: { name: cookieNameFor(requestId), value: nonce, maxAgeSeconds: REQUEST_TTL_MS / 1000 },
        };
    }

    // complete checks what was posted back. It answers the person and how
    // long the session made for them may last, or throws a Refusal.
    async complete({ samlResponse, cookies }) {
        if (typeof samlResponse !== 'string' || samlResponse === '') throw new Refusal('no-response', 400);
        if (samlResponse.length > MAX_RESPONSE_BYTES * 2) throw new Refusal('too-large', 413);
        if (!/^[A-Za-z0-9+/\s]+=*\s*$/.test(samlResponse)) throw new Refusal('not-base64', 400);
        const xml = Buffer.from(samlResponse, 'base64').toString('utf8');
        if (xml.length > MAX_RESPONSE_BYTES) throw new Refusal('too-large', 413);
        // Neither has any business in a SAML message, and both are how an
        // XML parser is made to read something other than what was signed.
        if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Refusal('doctype', 400);
        const doc = parse(xml);
        if (!doc) throw new Refusal('not-xml', 400);

        let certs;
        try {
            certs = await this.certificates.get();
        } catch (err) {
            throw new Refusal('no-certificate', 503, err.message);
        }

        // The response as the identity provider signed it. Everything read
        // about the response below is read from these bytes, never from what
        // was posted.
        let signed = this.verifiedResponse(xml, doc, certs);
        if (!signed && (await this.certificates.refreshIfStale())) {
            certs = this.certificates.known();
            signed = this.verifiedResponse(xml, doc, certs);
        }
        if (!signed) throw new Refusal('signature', 401);

        const response = parse(signed);
        const root = response && response.documentElement;
        if (!root || root.namespaceURI !== NS_PROTOCOL || root.localName !== 'Response') {
            throw new Refusal('not-a-response', 401);
        }
        const requestId = root.getAttribute('InResponseTo') || '';
        if (!requestId) throw new Refusal('unsolicited', 401);

        // From here on the request this answers is spent, whatever happens.
        const waiting = this.pending.take(requestId);
        if (!waiting) throw new Refusal('in-response-to', 401);

        const nonce = cookies[cookieNameFor(requestId)];
        if (!nonce || !sameString(sha256(nonce), waiting.nonceHash)) throw new Refusal('other-browser', 401);

        if (root.getAttribute('Destination') !== this.config.acsUrl) throw new Refusal('destination', 401);
        if (text(only(root, NS_ASSERTION, 'Issuer')) !== this.config.idpEntityId) throw new Refusal('issuer', 401);
        const status = only(root, NS_PROTOCOL, 'Status');
        const statusCode = status && only(status, NS_PROTOCOL, 'StatusCode');
        if (!statusCode || statusCode.getAttribute('Value') !== STATUS_SUCCESS) throw new Refusal('status', 401);
        if (children(root, NS_ASSERTION, 'EncryptedAssertion').length > 0) throw new Refusal('encrypted', 401);
        if (children(root, NS_ASSERTION, 'Assertion').length !== 1) throw new Refusal('assertions', 401);

        // The library's own checks: both signatures again, the audience, the
        // validity periods and that the assertion answers the same request.
        let profile;
        try {
            const saml = new SAML(this.samlOptions(certs, {
                cacheProvider: {
                    saveAsync: async () => null,
                    getAsync: async (id) => (id === requestId ? waiting.createdAt : null),
                    removeAsync: async () => null,
                },
            }));
            ({ profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse }));
        } catch (err) {
            throw new Refusal('invalid', 401, err.message);
        }
        if (!profile || profile.inResponseTo !== requestId) throw new Refusal('invalid', 401, 'no profile');

        // The assertion, as signed.
        const assertionDoc = parse(profile.getAssertionXml());
        const assertion = assertionDoc && assertionDoc.documentElement;
        if (!assertion || assertion.namespaceURI !== NS_ASSERTION || assertion.localName !== 'Assertion') {
            throw new Refusal('assertions', 401);
        }
        if (text(only(assertion, NS_ASSERTION, 'Issuer')) !== this.config.idpEntityId) throw new Refusal('issuer', 401);

        const subject = only(assertion, NS_ASSERTION, 'Subject');
        const nameId = subject && only(subject, NS_ASSERTION, 'NameID');
        if (!nameId || nameId.getAttribute('Format') !== NAMEID_EMAIL) throw new Refusal('name-id', 401);
        const email = text(nameId).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) throw new Refusal('name-id', 401);

        const confirmations = subject ? children(subject, NS_ASSERTION, 'SubjectConfirmation') : [];
        const addressedHere = confirmations.some((confirmation) => {
            const data = only(confirmation, NS_ASSERTION, 'SubjectConfirmationData');
            return confirmation.getAttribute('Method') === METHOD_BEARER &&
                data && data.getAttribute('Recipient') === this.config.acsUrl &&
                data.getAttribute('InResponseTo') === requestId;
        });
        if (!addressedHere) throw new Refusal('recipient', 401);

        const conditions = only(assertion, NS_ASSERTION, 'Conditions');
        const notOnOrAfter = conditions ? Date.parse(conditions.getAttribute('NotOnOrAfter') || '') : NaN;
        if (!Number.isFinite(notOnOrAfter)) throw new Refusal('conditions', 401);

        // One assertion is one sign-in.
        const assertionId = assertion.getAttribute('ID') || '';
        if (!assertionId || this.used.has(assertionId)) throw new Refusal('replay', 401);
        if (!this.used.set(assertionId, true, notOnOrAfter + this.config.clockSkewMs + 1000)) {
            throw new Refusal('busy', 503);
        }

        // The person the identity provider vouches for is the person the
        // front door admitted when this sign-in began.
        if (!sameString(email, waiting.email)) throw new Refusal('other-person', 403);

        // A session made here never outlasts the realm session it came from.
        let sessionSeconds = this.config.sessionMaxSeconds;
        const statement = children(assertion, NS_ASSERTION, 'AuthnStatement')[0];
        const sessionEnd = statement ? Date.parse(statement.getAttribute('SessionNotOnOrAfter') || '') : NaN;
        if (Number.isFinite(sessionEnd)) {
            sessionSeconds = Math.min(sessionSeconds, Math.floor((sessionEnd - this.now()) / 1000));
        }
        if (sessionSeconds < 1) throw new Refusal('session-over', 401);

        return {
            person: Object.freeze({ email, name: waiting.name, appAdmin: appAdminIn(assertion) }),
            sessionSeconds,
            requestId,
            // The realm session this sign-in came from, as the realm names it
            // when that session ends (lib/signout.js).
            sessionIndex: statement ? statement.getAttribute('SessionIndex') || '' : '',
            spentCookie: cookieNameFor(requestId),
        };
    }

    verifiedResponse(xml, doc, certs) {
        try {
            return samlXml.getVerifiedXml(xml, doc.documentElement, certs.map(toPem));
        } catch {
            return null;
        }
    }
}

module.exports = { SignIn, Refusal, cookieNameFor, REQUEST_TTL_MS, NAMEID_EMAIL, ROLE_ATTRIBUTE, APP_ADMIN_ROLE };
