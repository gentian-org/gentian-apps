'use strict';

// A browser for the end-to-end run, and the platform's front door in front of
// the app.
//
// Nothing here listens on a public name. A public address is mapped to the
// container that answers it, and the request is sent there with the Host
// header and the forwarding headers a proxy would set. Cookies are kept the
// way a browser keeps them, including the rule that decides this design: a
// cookie goes with a POST from another site only if it is SameSite=None.

const http = require('http');

function site(host) {
    return host.split(':')[0].split('.').slice(-2).join('.');
}

class Browser {
    constructor(routes) {
        this.routes = routes; // host -> (request) => { upstream, headers } | { respond }
        this.jar = [];        // { host, name, value, path, sameSite, httpOnly, secure, expires }
        this.storage = {};    // origin -> { key: value }, what a page's script wrote
        this.log = [];
    }

    setCookies(host, headers) {
        for (const line of headers['set-cookie'] || []) {
            const [pair, ...attrs] = line.split(';').map((s) => s.trim());
            const eq = pair.indexOf('=');
            const cookie = { host, name: pair.slice(0, eq), value: pair.slice(eq + 1), path: '/', sameSite: 'Lax', httpOnly: false, secure: false, raw: line };
            let maxAge = null;
            for (const attr of attrs) {
                const [k, v] = attr.split('=');
                const key = k.toLowerCase();
                if (key === 'path') cookie.path = v;
                if (key === 'samesite') cookie.sameSite = v;
                if (key === 'httponly') cookie.httpOnly = true;
                if (key === 'secure') cookie.secure = true;
                if (key === 'max-age') maxAge = parseInt(v, 10);
                if (key === 'expires' && Date.parse(attr.slice(8)) < Date.now()) maxAge = 0;
            }
            this.jar = this.jar.filter((c) => !(c.host === host && c.name === cookie.name && c.path === cookie.path));
            if (maxAge === null || maxAge > 0) this.jar.push(cookie);
        }
    }

    cookiesFor(host, path, { method, fromHost }) {
        const crossSite = fromHost && site(fromHost) !== site(host);
        return this.jar.filter((c) => {
            if (c.host !== host) return false;
            if (!(path === c.path || path.startsWith(c.path.endsWith('/') ? c.path : c.path + '/') || c.path === '/')) return false;
            if (!crossSite) return true;
            if (c.sameSite.toLowerCase() === 'none') return true;
            // Lax: with a top-level navigation by a safe method, and not otherwise.
            return c.sameSite.toLowerCase() === 'lax' && method === 'GET';
        });
    }

    cookie(host, name) {
        return this.jar.find((c) => c.host === host && c.name === name);
    }

    // One request, no redirect followed.
    request(method, url, { form, json, fromHost, headers } = {}) {
        const target = new URL(url);
        const route = this.routes[target.host];
        if (!route) throw new Error(`no route for ${target.host}`);
        const sent = this.cookiesFor(target.host, target.pathname, { method, fromHost });
        const req = {
            method, host: target.host, path: target.pathname + target.search, pathname: target.pathname,
            headers: { ...(headers || {}) },
        };
        if (sent.length > 0) req.headers.cookie = sent.map((c) => `${c.name}=${c.value}`).join('; ');
        let body;
        if (form) {
            body = new URLSearchParams(form).toString();
            req.headers['content-type'] = 'application/x-www-form-urlencoded';
        } else if (json !== undefined) {
            body = JSON.stringify(json);
            req.headers['content-type'] = 'application/json';
        }
        const routed = route(req);
        this.log.push(`${method} ${target.host}${target.pathname}`);
        if (routed.respond) {
            this.setCookies(target.host, routed.respond.headers || {});
            return Promise.resolve({ url, ...routed.respond, body: routed.respond.body || '' });
        }
        const upstream = new URL(routed.upstream);
        return new Promise((resolve, reject) => {
            const out = http.request({
                host: upstream.hostname, port: upstream.port, method, path: req.path,
                headers: {
                    ...req.headers, ...(routed.headers || {}),
                    host: target.host, 'x-forwarded-proto': 'https', 'x-forwarded-host': target.host,
                    ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
                },
            }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    this.setCookies(target.host, res.headers);
                    resolve({ url, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
                });
            });
            out.on('error', reject);
            if (body) out.write(body);
            out.end();
        });
    }

    // A navigation: follows redirects, and submits the form the identity
    // provider answers with -- its sign-in form when credentials are given,
    // the form that posts the SAML answer always.
    async navigate(url, { credentials, fromHost, max = 15 } = {}) {
        let res = await this.request('GET', url, { fromHost });
        for (let i = 0; i < max; i++) {
            const here = new URL(res.url);
            if ([301, 302, 303, 307].includes(res.status) && res.headers.location) {
                const next = new URL(res.headers.location, res.url);
                res = await this.request('GET', next.toString(), { fromHost: here.host });
                continue;
            }
            const samlForm = /<FORM[^>]*ACTION="([^"]+)"[^>]*>[\s\S]*?NAME="SAMLResponse"\s+VALUE="([^"]+)"/i.exec(res.body);
            if (samlForm) {
                this.lastSamlResponse = samlForm[2];
                res = await this.request('POST', decodeHtml(samlForm[1]), { form: { SAMLResponse: samlForm[2] }, fromHost: here.host });
                continue;
            }
            const loginForm = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(res.body);
            if (loginForm && credentials) {
                res = await this.request('POST', decodeHtml(loginForm[1]), { form: credentials, fromHost: here.host });
                credentials = null;
                continue;
            }
            // The page the sidecar writes for an app that keeps its session
            // in the browser's storage: do what its script does.
            const page = /var d=(\{.*?\});for\(var k in d\.storage\)/.exec(res.body);
            if (page && (res.headers['content-security-policy'] || '').includes('nonce-')) {
                const data = JSON.parse(page[1]);
                this.storage[here.origin] = { ...(this.storage[here.origin] || {}), ...data.storage };
                res = await this.request('GET', new URL(data.redirect, res.url).toString(), { fromHost: here.host });
                continue;
            }
            return res;
        }
        throw new Error('too many redirects: ' + this.log.slice(-max).join(' -> '));
    }
}

function decodeHtml(s) {
    return s.replace(/&amp;/g, '&').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// The front door, as the platform's Gateway and bouncer present an app with a
// sign-in sidecar:
//
//   <login path>   behind the session: reaches the sidecar with the identity
//                  headers of the person signed in at the front door;
//   <ACS path>     POST only, no session: reaches the sidecar with no
//                  identity header, whatever the browser sent;
//   entry paths    redirected to the login path;
//   denied paths   refused;
//   anything else  behind the session: reaches the app with the identity
//                  headers, and without the front door's own cookies.
//
// door.person is who is signed in at the front door; null is nobody, and then
// nothing behind the session is reached.
function frontDoor({ door, sidecar, app, entryPaths = [], denyPaths = [], realm }) {
    const identity = () => ({
        'x-gentian-subject': door.person.subject,
        'x-gentian-realm': realm,
        'x-gentian-session': 'e2e-session',
        'x-gentian-email': door.person.email,
        'x-gentian-name': door.person.name,
    });
    const strip = (req) => {
        for (const name of Object.keys(req.headers)) {
            if (name.startsWith('x-gentian-')) delete req.headers[name];
        }
    };
    return (req) => {
        strip(req);
        if (req.pathname === '/sso/acs') {
            if (req.method !== 'POST') return { respond: { status: 404, headers: {} } };
            return { upstream: sidecar };
        }
        if (!door.person) return { respond: { status: 302, headers: { location: 'https://front-door.invalid/sign-in' } } };
        if (denyPaths.some((p) => req.pathname === p || req.pathname.startsWith(p + '/'))) {
            return { respond: { status: 403, headers: {}, body: 'path is not published' } };
        }
        if (req.pathname === '/sso/login') return { upstream: sidecar, headers: identity() };
        if (entryPaths.includes(req.pathname)) {
            return { respond: { status: 302, headers: { location: '/sso/login' } } };
        }
        if (!app) return { respond: { status: 200, headers: {}, body: 'the app' } };
        return { upstream: app, headers: identity() };
    };
}

function keycloak(upstream) {
    return () => ({ upstream });
}

module.exports = { Browser, frontDoor, keycloak, site };
