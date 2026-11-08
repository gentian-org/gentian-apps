'use strict';

// Logout tokens the realm did not issue, for showing that an app believes
// none of them.

const crypto = require('crypto');

function b64(value) {
    return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

// The claims a realm puts in a logout token, for a session and a person.
function claims({ issuer, audience, sub, sid }) {
    const now = Math.floor(Date.now() / 1000);
    return {
        iss: issuer, aud: audience, sub, sid, typ: 'Logout', iat: now, exp: now + 120,
        jti: crypto.randomUUID(), events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    };
}

// Signed, with a key made here. kid is the realm's own key's name, so that
// an app which looks the key up by name finds the realm's key -- and a
// signature that key did not make.
function signedByAStranger(payload, kid) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const head = b64({ alg: 'RS256', typ: 'logout+jwt', kid });
    const body = b64(payload);
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    return `${head}.${body}.${signature}`;
}

// Not signed at all.
function unsigned(payload) {
    return `${b64({ alg: 'none', typ: 'logout+jwt' })}.${b64(payload)}.`;
}

// The header of a token the realm posted.
function headerOf(token) {
    return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
}

module.exports = { claims, signedByAStranger, unsigned, headerOf };
