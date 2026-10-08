'use strict';

const crypto = require('crypto');

// What a handler answers, and the response written from it.
//
// A handler never writes to the browser. It answers a description -- where to
// go next, which cookies carry the app's session, and, for an app that keeps
// its session in the browser's storage, what to put there -- and this module
// writes the response. So the attributes of every cookie, the address the
// browser is sent to and the one page that runs script are the same for every
// app, and none of them is a handler's to get wrong.

// Names the front door keeps for itself. A cookie under one of them would be
// taken out of every request by the bouncer, or mistaken for a session.
const RESERVED_COOKIE = /^(gentian-|__secure-gentian|__host-gentian|accesstoken-|idtoken-|refreshtoken-|oauthhmac-|oauthexpires-|oauthnonce-|codeverifier-)/i;
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{0,3800}$/;
const MAX_STORAGE_BYTES = 64 * 1024;

class BadAnswer extends Error {}

function checkRedirect(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
        throw new BadAnswer('redirect is not a path');
    }
    // A path on this app's own address, and nothing a browser could read as
    // another address.
    if (!value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20\x7f]/.test(value)) {
        throw new BadAnswer('redirect is not a path on this address');
    }
    return value;
}

function checkCookies(cookies) {
    if (cookies === undefined) return [];
    if (!Array.isArray(cookies) || cookies.length > 8) throw new BadAnswer('cookies is not a short list');
    return cookies.map((cookie) => {
        if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') {
            throw new BadAnswer('a cookie has no name or no value');
        }
        if (!COOKIE_NAME.test(cookie.name) || RESERVED_COOKIE.test(cookie.name)) {
            throw new BadAnswer('a cookie has a name it may not have');
        }
        if (!COOKIE_VALUE.test(cookie.value)) throw new BadAnswer('a cookie has a value a cookie cannot carry');
        return { name: cookie.name, value: cookie.value, httpOnly: cookie.httpOnly !== false };
    });
}

function checkStorage(storage) {
    if (storage === undefined) return null;
    if (!storage || typeof storage !== 'object' || Array.isArray(storage)) {
        throw new BadAnswer('localStorage is not an object');
    }
    let bytes = 0;
    const out = {};
    for (const [key, value] of Object.entries(storage)) {
        if (typeof value !== 'string') throw new BadAnswer('a localStorage value is not a string');
        bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
        out[key] = value;
    }
    if (bytes > MAX_STORAGE_BYTES) throw new BadAnswer('localStorage is too large');
    return Object.keys(out).length > 0 ? out : null;
}

// checkAnswer holds a handler's answer to what an answer may be.
function checkAnswer(answer) {
    if (!answer || typeof answer !== 'object') throw new BadAnswer('the handler answered nothing');
    if (answer.refuse !== undefined) {
        return { refuse: true };
    }
    const known = ['redirect', 'cookies', 'localStorage'];
    for (const key of Object.keys(answer)) {
        if (!known.includes(key)) throw new BadAnswer(`the handler answered "${key}", which is not understood`);
    }
    return {
        redirect: checkRedirect(answer.redirect),
        cookies: checkCookies(answer.cookies),
        localStorage: checkStorage(answer.localStorage),
    };
}

function sessionCookie(cookie, maxAgeSeconds) {
    return `${cookie.name}=${cookie.value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; SameSite=Lax` +
        (cookie.httpOnly ? '; HttpOnly' : '');
}

// JSON that is safe inside a <script> element: nothing in it can end the
// element or start a comment, whatever a person is called.
function scriptJson(value) {
    const lineSeparators = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(lineSeparators, (c) => '\\u' + c.charCodeAt(0).toString(16));
}

const BASE_HEADERS = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
};

// writeAnswer sends the browser on, signed in.
function writeAnswer(res, answer, { sessionSeconds, extraCookies = [] }) {
    const setCookie = [...extraCookies, ...answer.cookies.map((c) => sessionCookie(c, sessionSeconds))];
    if (!answer.localStorage) {
        res.writeHead(303, { ...BASE_HEADERS, Location: answer.redirect, 'Set-Cookie': setCookie });
        res.end();
        return;
    }
    const nonce = crypto.randomBytes(18).toString('base64');
    const data = scriptJson({ storage: answer.localStorage, redirect: answer.redirect });
    const page = '<!doctype html>\n<html><head><meta charset="utf-8"><title>Signing in</title></head><body>\n' +
        `<script nonce="${nonce}">(function(){var d=${data};` +
        'for(var k in d.storage){if(Object.prototype.hasOwnProperty.call(d.storage,k)){' +
        'window.localStorage.setItem(k,d.storage[k]);}}window.location.replace(d.redirect);})();</script>\n' +
        '</body></html>\n';
    res.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
        'Set-Cookie': setCookie,
    });
    res.end(page);
}

const MESSAGES = {
    400: 'The sign-in request could not be read.',
    401: 'The sign-in could not be completed. Open the app again from your desktop.',
    403: 'You are not signed in to this app. Open it from your desktop.',
    404: 'Not found.',
    405: 'Method not allowed.',
    413: 'The sign-in request is too large.',
    502: 'The app could not sign you in. Try again in a moment.',
    503: 'Sign-in is not available at the moment. Try again in a moment.',
    504: 'The app took too long to sign you in. Try again in a moment.',
};

// writeRefusal tells the browser no, and never why in more words than these:
// the reason is in the log, under the reference shown.
function writeRefusal(res, status, reference, extraHeaders) {
    const message = MESSAGES[status] || MESSAGES[401];
    res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...(extraHeaders || {}) });
    res.end(reference ? `${message}\nReference: ${reference}\n` : `${message}\n`);
}

module.exports = { checkAnswer, writeAnswer, writeRefusal, scriptJson, BadAnswer, BASE_HEADERS };
