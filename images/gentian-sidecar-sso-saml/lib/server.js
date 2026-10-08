'use strict';

const crypto = require('crypto');
const http = require('http');
const querystring = require('querystring');
const log = require('./log');
const { Refusal } = require('./signin');
const { checkAnswer, writeAnswer, writeRefusal, BadAnswer, BASE_HEADERS } = require('./reply');

// The front door's identity headers. They are set by the bouncer on a request
// it admitted and are worth nothing on any other request.
const IDENTITY_HEADERS = ['x-gentian-subject', 'x-gentian-realm', 'x-gentian-session', 'x-gentian-email', 'x-gentian-name'];

const MAX_BODY_BYTES = 768 * 1024;
const HANDLER_TIMEOUT_MS = 20000;

function parseCookies(header) {
    const out = Object.create(null);
    if (typeof header !== 'string') return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 1) continue;
        const name = part.slice(0, eq).trim();
        if (!(name in out)) out[name] = part.slice(eq + 1).trim();
    }
    return out;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Refusal('too-large', 413));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', () => reject(new Refusal('aborted', 400)));
    });
}

function header(req, name) {
    const value = req.headers[name];
    return typeof value === 'string' ? value.trim() : '';
}

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Refusal('handler-timeout', 504)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createServer({ config, signIn, handler, certificates }) {
    const expireCookie = (name) => `${name}=; Path=${config.acsPath}; Max-Age=0; Secure; HttpOnly; SameSite=None`;

    async function login(req, res, reference) {
        // A sign-in begins only for somebody the front door has admitted to
        // this app. Whether a person may use the app is the platform's
        // answer; this path is behind it, and the answer is these headers.
        const email = header(req, 'x-gentian-email');
        if (!header(req, 'x-gentian-subject') || !email) throw new Refusal('not-through-the-front-door', 403);
        if (header(req, 'x-gentian-realm') !== config.realm) throw new Refusal('other-realm', 403);
        if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) throw new Refusal('no-address', 403);

        const { redirectUrl, cookie } = await signIn.begin({ email, name: header(req, 'x-gentian-name').slice(0, 200) });
        res.writeHead(302, {
            ...BASE_HEADERS,
            Location: redirectUrl,
            // SameSite=None: the identity provider posts the answer from its
            // own address, which for a tenant on a domain of its own is
            // another site, and a browser sends no other kind of cookie with
            // such a request. It carries a random value and nothing else.
            'Set-Cookie': `${cookie.name}=${cookie.value}; Path=${config.acsPath}; Max-Age=${cookie.maxAgeSeconds}; Secure; HttpOnly; SameSite=None`,
        });
        res.end();
        log.info('sign-in-started', { reference });
    }

    async function acs(req, res, reference) {
        // Nothing has vouched for this request, so nothing it says about
        // itself is believed, and the handler is not shown it at all.
        for (const name of IDENTITY_HEADERS) delete req.headers[name];

        const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/x-www-form-urlencoded') throw new Refusal('not-a-form', 400);
        const form = querystring.parse(await readBody(req), '&', '=', { maxKeys: 8 });
        const samlResponse = Array.isArray(form.SAMLResponse) ? '' : form.SAMLResponse;

        const result = await signIn.complete({ samlResponse, cookies: parseCookies(req.headers.cookie) });
        const spent = [expireCookie(result.spentCookie)];

        let answer;
        try {
            answer = checkAnswer(await withTimeout(
                Promise.resolve().then(() => handler.onLogin(result.person, Object.freeze({
                    sessionSeconds: result.sessionSeconds,
                    origin: config.origin,
                    log: (event, fields) => log.info('handler', { reference, note: String(event).slice(0, 200), ...(fields || {}) }),
                }))),
                HANDLER_TIMEOUT_MS,
            ));
        } catch (err) {
            if (err instanceof Refusal) {
                err.cookies = spent;
                throw err;
            }
            const refusal = new Refusal(err instanceof BadAnswer ? 'handler-answer' : 'handler-failed', 502,
                // A handler's error may quote what it was working on.
                err instanceof BadAnswer ? err.message : (err && err.code) || (err && err.name) || 'error');
            refusal.cookies = spent;
            throw refusal;
        }
        if (answer.refuse) {
            const refusal = new Refusal('handler-refused', 403);
            refusal.cookies = spent;
            throw refusal;
        }
        writeAnswer(res, answer, { sessionSeconds: result.sessionSeconds, extraCookies: spent });
        log.info('signed-in', { reference, sessionSeconds: result.sessionSeconds });
    }

    return http.createServer(async (req, res) => {
        const reference = crypto.randomBytes(6).toString('hex');
        let path;
        try {
            path = new URL(req.url, 'http://sidecar.invalid').pathname;
        } catch {
            writeRefusal(res, 400);
            return;
        }

        // For the kubelet, which calls the pod by its address.
        if (path === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok\n');
            return;
        }
        if (path === '/readyz') {
            let ready = Boolean(certificates.known());
            if (!ready) {
                try {
                    await certificates.get();
                    ready = true;
                } catch (err) {
                    log.warn('certificate-not-loaded', { detail: err.message });
                }
            }
            res.writeHead(ready ? 200 : 503, { 'Content-Type': 'text/plain' });
            res.end(ready ? 'ok\n' : 'the identity provider\'s certificate is not known yet\n');
            return;
        }

        try {
            if (path !== config.loginPath && path !== config.acsPath) {
                writeRefusal(res, 404);
                return;
            }
            if ((req.headers.host || '').toLowerCase() !== config.host) throw new Refusal('other-host', 404);
            if (path === config.loginPath) {
                if (req.method !== 'GET') throw new Refusal('method', 405);
                await login(req, res, reference);
            } else {
                if (req.method !== 'POST') throw new Refusal('method', 405);
                await acs(req, res, reference);
            }
        } catch (err) {
            const refusal = err instanceof Refusal ? err : new Refusal('error', 502, (err && err.name) || 'error');
            log.warn('sign-in-refused', { reference, reason: refusal.code, detail: refusal.detail, path });
            if (res.headersSent) {
                res.end();
                return;
            }
            writeRefusal(res, refusal.status, reference, refusal.cookies ? { 'Set-Cookie': refusal.cookies } : undefined);
        }
    });
}

module.exports = { createServer, parseCookies, IDENTITY_HEADERS };
