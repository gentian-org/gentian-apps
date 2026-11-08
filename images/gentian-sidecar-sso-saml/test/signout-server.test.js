'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test, before, after } = require('node:test');
const { createServer } = require('../lib/server');
const { loadConfig } = require('../lib/config');
const { makeIdp, makeSignOut, buildLogoutRequest, ENV, LOGOUT_URL } = require('./helpers');

// The sign-out path as the realm reaches it: by the sidecar's name inside the
// cluster, with a form that carries the request.

const INTERNAL_HOST = new URL(LOGOUT_URL).host;
const PUBLIC_HOST = 'app.acme.example.org';

let idp;

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function call(port, { method = 'POST', path = '/sso/logout', host = INTERNAL_HOST, headers = {}, body }) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host, ...headers } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function form(fields) {
    return {
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&'),
    };
}

// What Keycloak posts: the request, and a marker field of its own.
function realmPost(request) {
    return form([['SAMLRequest', request], ['BACK_CHANNEL_LOGOUT', 'BACK_CHANNEL_LOGOUT']]);
}

async function start(handler, made) {
    made = made || makeSignOut(idp);
    const server = createServer({ config: made.config, signIn: made.signIn, signOut: made.signOut, handler, certificates: made.certificates });
    const port = await listen(server);
    return { ...made, server, port };
}

const servers = [];
async function started(handler, made) {
    const s = await start(handler, made);
    servers.push(s.server);
    return s;
}

before(() => { idp = makeIdp(); });
after(() => { for (const s of servers) s.close(); });

test('the realm\'s request reaches the handler\'s onLogout with the person and nothing of the request', async () => {
    const calls = [];
    const s = await started({ async onLogin() {}, async onLogout(person, ctx) { calls.push({ person, ctx }); } });
    const res = await call(s.port, {
        ...realmPost(buildLogoutRequest(idp, s.config)),
        headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'x-gentian-email': 'ben@acme.example.org', 'x-gentian-subject': 'forged',
        },
    });
    assert.equal(res.status, 200, res.body);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].person, { email: 'anna@acme.example.org' });
    assert.deepEqual(Object.keys(calls[0].ctx).sort(), ['log', 'origin']);
    assert.equal(calls[0].ctx.origin, 'https://' + PUBLIC_HOST);
    assert.ok(Object.isFrozen(calls[0].ctx));
});

test('a handler without onLogout: the realm is answered, and nothing is ended', async () => {
    const s = await started({ async onLogin() {} });
    const res = await call(s.port, realmPost(buildLogoutRequest(idp, s.config)));
    assert.equal(res.status, 200);
});

test('a forged, an unsigned and a replayed request end nothing', async () => {
    const other = makeIdp();
    const calls = [];
    const s = await started({ async onLogin() {}, async onLogout(person) { calls.push(person); } });
    assert.equal((await call(s.port, realmPost(buildLogoutRequest(idp, s.config, { key: other.key })))).status, 401);
    assert.equal((await call(s.port, realmPost(buildLogoutRequest(idp, s.config, { signed: false })))).status, 401);
    assert.equal(calls.length, 0);
    const request = buildLogoutRequest(idp, s.config);
    assert.equal((await call(s.port, realmPost(request))).status, 200);
    assert.equal((await call(s.port, realmPost(request))).status, 401);
    assert.equal(calls.length, 1);
});

test('two requests in one post are refused', async () => {
    const calls = [];
    const s = await started({ async onLogin() {}, async onLogout(person) { calls.push(person); } });
    const res = await call(s.port, form([
        ['SAMLRequest', buildLogoutRequest(idp, s.config)],
        ['SAMLRequest', buildLogoutRequest(idp, s.config, { email: 'ben@acme.example.org' })],
    ]));
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
});

test('the path answers only under the name the realm calls, and only a POST of a form', async () => {
    const calls = [];
    const s = await started({ async onLogin() {}, async onLogout(person) { calls.push(person); } });
    const good = () => realmPost(buildLogoutRequest(idp, s.config));
    // Under the app's public name -- which is how a request from outside
    // would arrive, if the path were routed at all.
    assert.equal((await call(s.port, { ...good(), host: PUBLIC_HOST })).status, 404);
    assert.equal((await call(s.port, { ...good(), host: 'other-sign-in.tenant-acme.svc.cluster.local:8081' })).status, 404);
    assert.equal((await call(s.port, { ...good(), method: 'GET', body: undefined })).status, 405);
    assert.equal((await call(s.port, { headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
    assert.equal(calls.length, 0);
});

test('a sidecar that is given no sign-out address has no such path', async () => {
    const made = makeSignOut(idp);
    const config = loadConfig(ENV);
    assert.equal(config.logoutUrl, null);
    const server = createServer({ config, signIn: made.signIn, signOut: null, handler: { async onLogin() {}, async onLogout() { throw new Error('called'); } }, certificates: made.certificates });
    servers.push(server);
    const port = await listen(server);
    const res = await call(port, realmPost(buildLogoutRequest(idp, made.config)));
    assert.equal(res.status, 404);
});

test('a handler that fails is told to the realm as a failure, and the request is spent', async () => {
    let fail = true;
    const s = await started({ async onLogin() {}, async onLogout() { if (fail) throw new Error('database is away: anna@acme.example.org'); } });
    const request = buildLogoutRequest(idp, s.config);
    const res = await call(s.port, realmPost(request));
    assert.equal(res.status, 502);
    assert.doesNotMatch(res.body, /anna|database/);
    fail = false;
    assert.equal((await call(s.port, realmPost(request))).status, 401);
});

test('the sign-in paths do not answer under the sign-out\'s name', async () => {
    const s = await started({ async onLogin() {} });
    assert.equal((await call(s.port, { method: 'GET', path: '/sso/login', host: INTERNAL_HOST, headers: { 'x-gentian-subject': 's', 'x-gentian-email': 'anna@acme.example.org', 'x-gentian-realm': 'acme' } })).status, 404);
});
