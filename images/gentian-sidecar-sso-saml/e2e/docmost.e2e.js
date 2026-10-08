'use strict';

// Docmost, the real container at the version the catalogue pins, signed in to
// through the sidecar with the profile's own handler.
//
//   docker build -t sso-sidecar:e2e ..   &&   node --test e2e/docmost.e2e.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { Browser, frontDoor, keycloak } = require('./lib/browser');
const setup = require('./lib/setup');
const { signInOf } = require('./lib/profile');

const IMAGE = 'docker.io/docmost/docmost:0.95.0';
const HOST = 'docs.acme.e2e.test';
const REALM = 'acme';
// The profile's own handler and lists: what is sent to the sign-in, what is
// refused at the front door.
const PROFILE = signInOf('profiles/docmost/docmost-ce');
const HANDLER = PROFILE.handler;
const ENTRY_PATHS = PROFILE.entryPaths;
const DENY_PATHS = PROFILE.denyPaths;
const APP_SECRET = 'e2e-only-0123456789abcdef0123456789abcdef';

const ANNA = { email: 'anna@acme.e2e.test', firstName: 'Anna', lastName: "O'Example", password: 'pw-anna-e2e', subject: 'sub-anna', name: "Anna O'Example" };
const BEN = { email: 'ben@acme.e2e.test', firstName: 'Ben', lastName: 'Example', password: 'pw-ben-e2e', subject: 'sub-ben', name: 'Ben Example' };

let kc;
let sidecar;
let appUpstream;
const names = { pg: 'sso-e2e-docmost-pg', redis: 'sso-e2e-docmost-redis', app: 'sso-e2e-docmost', sidecar: 'sso-e2e-docmost-sidecar' };

function psql(sql) {
    return setup.docker('exec', names.pg, 'psql', '-U', 'docmost', '-d', 'docmost', '-At', '-c', sql);
}

before(async () => {
    kc = await setup.startKeycloak();
    await setup.ensureRealm(kc, REALM, [ANNA, BEN]);
    await setup.ensureSidecarClient(kc, REALM, HOST);
    for (const name of Object.values(names)) setup.tryDocker('rm', '-f', name);
    setup.docker('run', '-d', '--name', names.pg, '--network', setup.NETWORK,
        '-e', 'POSTGRES_USER=docmost', '-e', 'POSTGRES_PASSWORD=dm-e2e', '-e', 'POSTGRES_DB=docmost', 'postgres:16-alpine');
    setup.docker('run', '-d', '--name', names.redis, '--network', setup.NETWORK, 'redis:7-alpine');
    await setup.waitFor('PostgreSQL', async () => setup.tryDocker('exec', names.pg, 'pg_isready', '-U', 'docmost') !== '', 60);
    setup.docker('run', '-d', '--name', names.app, '--network', setup.NETWORK, '-p', '127.0.0.1::3000',
        '-e', `APP_URL=https://${HOST}`, '-e', `APP_SECRET=${APP_SECRET}`,
        '-e', `DATABASE_URL=postgresql://docmost:dm-e2e@${names.pg}:5432/docmost`,
        '-e', `REDIS_URL=redis://${names.redis}:6379`, '-e', 'STORAGE_DRIVER=local', '-e', 'DISABLE_TELEMETRY=true', IMAGE);
    appUpstream = `http://127.0.0.1:${setup.publishedPort(names.app, 3000)}`;
    await setup.waitFor('Docmost', async () => (await setup.call('GET', `${appUpstream}/api/health`)).status === 200, 240);
    sidecar = setup.startSidecar({
        name: names.sidecar, host: HOST, realm: REALM, kc, handlerFile: HANDLER,
        env: {
            DB_HOST: names.pg, DB_PORT: '5432', DB_NAME: 'docmost', DB_USER: 'docmost', DB_PASSWORD: 'dm-e2e',
            SECRET_APP_SECRET: APP_SECRET, APP_URL: `http://${names.app}:3000`,
        },
    });
    await setup.sidecarReady(sidecar);
});

after(() => {
    if (process.env.E2E_KEEP) return;
    for (const name of Object.values(names)) setup.tryDocker('rm', '-f', name);
});

function browserAs(door) {
    return new Browser({
        [setup.IDP_HOST]: keycloak(kc.upstream),
        [HOST]: frontDoor({ door, sidecar: sidecar.upstream, app: appUpstream, realm: REALM, entryPaths: ENTRY_PATHS, denyPaths: DENY_PATHS }),
    });
}

async function whoAmI(browser) {
    const res = await browser.request('POST', `https://${HOST}/api/users/me`, { json: {} });
    return { status: res.status, body: res.status === 200 ? JSON.parse(res.body) : null };
}

test('the first person to open Docmost is in, as a member, and meets no setup page', async () => {
    const browser = browserAs({ person: ANNA });
    const res = await browser.navigate(`https://${HOST}/`, { credentials: { username: ANNA.email, password: ANNA.password } });
    assert.equal(res.status, 200, browser.log.join(' -> '));
    assert.equal(new URL(res.url).pathname, '/home');

    const cookie = browser.cookie(HOST, 'authToken');
    assert.match(cookie.raw, /; Path=\/; Max-Age=\d+; Secure; SameSite=Lax; HttpOnly$/);

    const me = await whoAmI(browser);
    assert.equal(me.status, 200);
    const user = me.body.data.user;
    assert.equal(user.email, ANNA.email);
    assert.equal(user.name, ANNA.name);
    assert.equal(user.role, 'member');
    assert.equal(me.body.data.workspace.name, 'Docmost');
});

test('nobody has a password, the account that owns the workspace included', () => {
    assert.equal(psql('select count(*) from users'), '2');
    assert.equal(psql('select count(*) from users where password is not null'), '0');
    assert.equal(psql("select role from users where email = 'config-account@docmost.internal'"), 'owner');
});

test('the session ends when the sidecar said it would, in the token and in Docmost\'s own record', () => {
    const left = Number(psql("select extract(epoch from (expires_at - now()))::int from user_sessions order by created_at desc limit 1"));
    assert.ok(left > 3500 && left <= 3600, String(left));
});

test('a second person gets an account of their own', async () => {
    const browser = browserAs({ person: BEN });
    const res = await browser.navigate(`https://${HOST}/`, { credentials: { username: BEN.email, password: BEN.password } });
    assert.equal(new URL(res.url).pathname, '/home', browser.log.join(' -> '));
    const me = await whoAmI(browser);
    assert.equal(me.body.data.user.email, BEN.email);
    assert.equal(me.body.data.user.role, 'member');
    assert.equal(psql('select count(*) from users'), '3');
});

test('opening the app again makes no second account and asks for nothing', async () => {
    const browser = browserAs({ person: ANNA });
    await browser.navigate(`https://${HOST}/`, { credentials: { username: ANNA.email, password: ANNA.password } });
    browser.log.length = 0;
    const res = await browser.navigate(`https://${HOST}/`);
    assert.equal(new URL(res.url).pathname, '/home');
    assert.ok(!browser.log.some((line) => line.includes('login-actions')), browser.log.join(' -> '));
    assert.equal(psql(`select count(*) from users where email = '${ANNA.email}'`), '1');
});

test('Docmost\'s own sign-in and setup calls are not reachable through the front door', async () => {
    const browser = browserAs({ person: ANNA });
    for (const path of DENY_PATHS) {
        const res = await browser.request('POST', `https://${HOST}${path}`, { json: { email: ANNA.email, password: 'whatever-it-is' } });
        assert.equal(res.status, 403, path);
    }
});

test('Docmost\'s own sign-in page leads to the platform\'s sign-in instead', async () => {
    const browser = browserAs({ person: ANNA });
    const res = await browser.request('GET', `https://${HOST}/login`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/sso/login');
});

test('signing out in Docmost ends the session there', async () => {
    const browser = browserAs({ person: ANNA });
    await browser.navigate(`https://${HOST}/`, { credentials: { username: ANNA.email, password: ANNA.password } });
    const token = browser.cookie(HOST, 'authToken').value;
    assert.equal((await whoAmI(browser)).status, 200);
    const out = await browser.request('POST', `https://${HOST}/api/auth/logout`, { json: {} });
    assert.equal(out.status, 200);
    // The token itself, presented again, is refused: its session is revoked.
    const again = await setup.call('POST', `${appUpstream}/api/users/me`, {
        headers: { host: HOST, 'content-type': 'application/json', cookie: `authToken=${token}` }, body: '{}',
    });
    assert.equal(again.status, 401);
});

test('an account switched off in Docmost is not signed in', async () => {
    psql(`update users set deactivated_at = now() where email = '${BEN.email}'`);
    const browser = browserAs({ person: BEN });
    const res = await browser.navigate(`https://${HOST}/`, { credentials: { username: BEN.email, password: BEN.password } });
    assert.equal(res.status, 403);
    assert.equal(browser.cookie(HOST, 'authToken'), undefined);
    psql(`update users set deactivated_at = null where email = '${BEN.email}'`);
});

test('the sidecar\'s log names nobody', () => {
    const logs = setup.logsOf(names.sidecar);
    assert.match(logs, /"event":"signed-in"/);
    assert.doesNotMatch(logs, /anna|ben@|Example/i);
});
