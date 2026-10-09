'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test, before, after } = require('node:test');
const zlib = require('node:zlib');
const { createServer } = require('../lib/server');
const { makeIdp, buildResponse, makeSignIn, roleAttribute } = require('./helpers');

let idp;
let server;
let port;
let config;
let handlerCalls;
let handlerAnswer;

const FRONT_DOOR = {
    'x-gentian-subject': '5b6c0b0e-0000-4000-8000-000000000001',
    'x-gentian-realm': 'acme',
    'x-gentian-email': 'anna@acme.example.org',
    'x-gentian-name': 'Anna Example',
};

function call({ method = 'GET', path, headers = {}, body }) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, method, path,
            headers: { host: 'app.acme.example.org', ...headers },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function startSignIn(headers) {
    const res = await call({ path: '/sso/login', headers: headers || FRONT_DOOR });
    assert.equal(res.status, 302);
    const url = new URL(res.headers.location);
    const request = zlib.inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest'), 'base64')).toString('utf8');
    const cookie = res.headers['set-cookie'][0];
    return { requestId: /\bID="([^"]+)"/.exec(request)[1], cookie, cookiePair: cookie.split(';')[0] };
}

function post(samlResponse, headers) {
    return call({
        method: 'POST', path: '/sso/acs',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: 'SAMLResponse=' + encodeURIComponent(samlResponse),
    });
}

before(async () => {
    idp = makeIdp();
    const made = makeSignIn(idp);
    config = made.config;
    const handler = {
        async onLogin(person, ctx) {
            handlerCalls.push({ person, ctx });
            if (handlerAnswer instanceof Error) throw handlerAnswer;
            return handlerAnswer;
        },
    };
    server = createServer({ config, signIn: made.signIn, handler, certificates: made.certificates });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});

after(() => server.close());

test.beforeEach(() => {
    handlerCalls = [];
    handlerAnswer = { redirect: '/home', cookies: [{ name: 'authToken', value: 'abc.def.ghi' }] };
});

test('the health endpoints answer without a host or a session', async () => {
    assert.equal((await call({ path: '/healthz', headers: { host: '10.0.0.7:8081' } })).status, 200);
    assert.equal((await call({ path: '/readyz', headers: { host: '10.0.0.7:8081' } })).status, 200);
});

test('a sign-in does not begin for a request the front door did not admit', async () => {
    const res = await call({ path: '/sso/login' });
    assert.equal(res.status, 403);
    assert.equal(res.headers['set-cookie'], undefined);
    const noAddress = await call({ path: '/sso/login', headers: { ...FRONT_DOOR, 'x-gentian-email': '' } });
    assert.equal(noAddress.status, 403);
});

test('a sign-in does not begin for a person of another realm', async () => {
    const res = await call({ path: '/sso/login', headers: { ...FRONT_DOOR, 'x-gentian-realm': 'other' } });
    assert.equal(res.status, 403);
});

test('neither path answers under another host name', async () => {
    const login = await call({ path: '/sso/login', headers: { ...FRONT_DOOR, host: 'evil.example' } });
    assert.equal(login.status, 404);
    const acs = await post('AAAA', { host: 'evil.example' });
    assert.equal(acs.status, 404);
});

test('the login path takes GET only and the ACS path POST only', async () => {
    assert.equal((await call({ method: 'POST', path: '/sso/login', headers: FRONT_DOOR })).status, 405);
    assert.equal((await call({ path: '/sso/acs' })).status, 405);
    assert.equal((await call({ path: '/anything-else' })).status, 404);
});

test('the browser is sent to the realm with a cookie only the ACS path receives', async () => {
    const started = await startSignIn();
    assert.match(started.cookie, /^__Secure-gentian-sso-[0-9a-f]{16}=[A-Za-z0-9_-]{43}; Path=\/sso\/acs; Max-Age=300; Secure; HttpOnly; SameSite=None$/);
});

test('a checked answer becomes the app session the handler described', async () => {
    const started = await startSignIn();
    const res = await post(buildResponse(idp, config, { requestId: started.requestId }), { cookie: started.cookiePair });
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, '/home');
    assert.equal(res.headers['cache-control'], 'no-store');
    const cookies = res.headers['set-cookie'];
    assert.ok(cookies.includes('authToken=abc.def.ghi; Path=/; Max-Age=3600; Secure; SameSite=Lax; HttpOnly'), cookies.join(' | '));
    assert.ok(cookies.some((c) => c.startsWith(started.cookiePair.split('=')[0] + '=; ') && c.includes('Max-Age=0')));
    assert.equal(handlerCalls.length, 1);
    assert.deepEqual({ ...handlerCalls[0].person }, { email: 'anna@acme.example.org', name: 'Anna Example', appAdmin: false });
    assert.equal(handlerCalls[0].ctx.sessionSeconds, 3600);
    assert.equal(handlerCalls[0].ctx.origin, 'https://app.acme.example.org');
});

test('identity headers on the ACS request are not believed', async () => {
    const started = await startSignIn();
    const res = await post(buildResponse(idp, config, { requestId: started.requestId, email: 'boss@acme.example.org' }), {
        cookie: started.cookiePair,
        'x-gentian-email': 'boss@acme.example.org',
        'x-gentian-subject': 'somebody',
    });
    assert.equal(res.status, 403);
    assert.equal(handlerCalls.length, 0);
});

test('the handler is told the person administers the app when the realm\'s signed answer says so', async () => {
    const started = await startSignIn();
    const res = await post(buildResponse(idp, config, { requestId: started.requestId, attributes: roleAttribute(['gentian-app-admin']) }),
        { cookie: started.cookiePair });
    assert.equal(res.status, 303);
    assert.equal(handlerCalls[0].person.appAdmin, true);
    assert.ok(Object.isFrozen(handlerCalls[0].person));
});

test('nothing a request says about itself makes an administrator', async () => {
    // At the front door's side of the sign-in: headers a person could try.
    const claims = {
        'x-gentian-app-admin': 'true', 'x-gentian-roles': 'gentian-app-admin', 'x-gentian-groups': 'gentian:tenant:acme:app-admins',
        role: 'gentian-app-admin', 'x-forwarded-user': 'admin',
    };
    const started = await startSignIn({ ...FRONT_DOOR, ...claims });
    // And where the answer is posted: headers, a cookie, the address, and
    // fields of the form beside the realm's answer.
    const samlResponse = buildResponse(idp, config, { requestId: started.requestId });
    const res = await call({
        method: 'POST', path: '/sso/acs?appAdmin=true&Role=gentian-app-admin',
        headers: {
            'content-type': 'application/x-www-form-urlencoded', ...claims,
            cookie: started.cookiePair + '; appAdmin=true; Role=gentian-app-admin',
        },
        body: 'SAMLResponse=' + encodeURIComponent(samlResponse) + '&appAdmin=true&Role=gentian-app-admin',
    });
    assert.equal(res.status, 303);
    assert.equal(handlerCalls.length, 1);
    assert.equal(handlerCalls[0].person.appAdmin, false);
    assert.deepEqual(Object.keys(handlerCalls[0].person).sort(), ['appAdmin', 'email', 'name']);
});

test('a refused answer says nothing of why and starts no session', async () => {
    const started = await startSignIn();
    const res = await post(buildResponse(idp, config, { requestId: started.requestId, audience: 'https://elsewhere/sso' }), { cookie: started.cookiePair });
    assert.equal(res.status, 401);
    assert.doesNotMatch(res.body, /audience|anna|elsewhere/i);
    assert.match(res.body, /Reference: [0-9a-f]{12}/);
    assert.equal(handlerCalls.length, 0);
});

test('an answer without the browser\'s cookie is refused', async () => {
    const started = await startSignIn();
    const res = await post(buildResponse(idp, config, { requestId: started.requestId }));
    assert.equal(res.status, 401);
    assert.equal(handlerCalls.length, 0);
});

test('a session kept in the browser\'s storage is written by a page that cannot be broken out of', async () => {
    handlerAnswer = {
        redirect: '/flows',
        localStorage: { token: 'abc.def.ghi', currentUser: JSON.stringify({ firstName: '</script><script>alert(1)</script>', lastName: "O'Neil \"x\"" }) },
    };
    const started = await startSignIn();
    const res = await post(buildResponse(idp, config, { requestId: started.requestId }), { cookie: started.cookiePair });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    const nonce = /script-src 'nonce-([^']+)'/.exec(res.headers['content-security-policy'])[1];
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(res.body.split('<script').length, 2, 'exactly one script element');
    assert.equal(res.body.split('</script>').length, 2, 'the script element is closed exactly once');
    assert.ok(res.body.includes(`<script nonce="${nonce}">`));
    // What the page's script holds is what the handler said, unchanged.
    const data = JSON.parse(/var d=(\{.*?\});for/.exec(res.body)[1]);
    assert.deepEqual(data, { storage: handlerAnswer.localStorage, redirect: '/flows' });
});

test('a handler that fails signs nobody in and its error is not shown', async () => {
    handlerAnswer = new Error('duplicate key value for anna@acme.example.org');
    const started = await startSignIn();
    const res = await post(buildResponse(idp, config, { requestId: started.requestId }), { cookie: started.cookiePair });
    assert.equal(res.status, 502);
    assert.doesNotMatch(res.body, /duplicate|anna/);
    assert.equal(res.headers.location, undefined);
});

test('a handler may refuse a person', async () => {
    handlerAnswer = { refuse: true };
    const started = await startSignIn();
    const res = await post(buildResponse(idp, config, { requestId: started.requestId }), { cookie: started.cookiePair });
    assert.equal(res.status, 403);
});

test('a handler\'s answer is held to what an answer may be', async () => {
    for (const bad of [
        { redirect: 'https://evil.example/' },
        { redirect: '//evil.example/' },
        { redirect: '/\\evil.example' },
        { redirect: '/home', cookies: [{ name: 'gentian-acme-access', value: 'x' }] },
        { redirect: '/home', cookies: [{ name: 'AccessToken-abc', value: 'x' }] },
        { redirect: '/home', cookies: [{ name: 'a', value: 'x; Domain=example.org' }] },
        { redirect: '/home', cookies: [{ name: 'a b', value: 'x' }] },
        { redirect: '/home', localStorage: { token: 42 } },
        { redirect: '/home', headers: { 'Set-Cookie': 'x=y' } },
        {},
        null,
    ]) {
        handlerAnswer = bad;
        const started = await startSignIn();
        const res = await post(buildResponse(idp, config, { requestId: started.requestId }), { cookie: started.cookiePair });
        assert.equal(res.status, 502, JSON.stringify(bad));
        assert.equal(res.headers.location, undefined);
    }
});

test('a cookie is readable by the page only when the handler says so', async () => {
    handlerAnswer = { redirect: '/', cookies: [{ name: 'marker', value: '1', httpOnly: false }] };
    const started = await startSignIn();
    const res = await post(buildResponse(idp, config, { requestId: started.requestId }), { cookie: started.cookiePair });
    assert.ok(res.headers['set-cookie'].includes('marker=1; Path=/; Max-Age=3600; Secure; SameSite=Lax'));
});

test('only a form post is read', async () => {
    const res = await call({ method: 'POST', path: '/sso/acs', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 400);
});
