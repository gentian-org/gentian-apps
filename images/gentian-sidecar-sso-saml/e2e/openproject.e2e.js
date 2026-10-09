'use strict';

// OpenProject, the real container at the version the profile pins, started
// the way the profile's chart starts it with the profile's own values, signed
// in to through the sidecar with the profile's own handler.
//
//   docker build -t sso-sidecar:e2e ..   &&   node --test e2e/openproject.e2e.js
//
// Needs helm: the chart is fetched from where the profile says it is and
// rendered with the profile's values, and the container is given exactly the
// environment the chart gives its web pod. So a value the profile sets under
// a key the chart does not read is noticed here.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const YAML = require('yaml');
const { Browser, frontDoor, keycloak } = require('./lib/browser');
const setup = require('./lib/setup');
const { refusedSignOuts } = require('./lib/signout');
const { signInOf, REPO } = require('./lib/profile');

const HOST = 'projects.acme.e2e.test';
const DOMAIN = 'acme.e2e.test';
const REALM = 'acme';
const PROFILE_DIR = 'profiles/openproject/openproject-ce';
// The profile's own handler and lists: what is sent to the sign-in, what is
// refused at the front door.
const PROFILE = signInOf(PROFILE_DIR);
const HANDLER = PROFILE.handler;
const ENTRY_PATHS = PROFILE.entryPaths;
const DENY_PATHS = PROFILE.denyPaths;

// What the platform generates for the app, one value per name under
// spec.secrets.generated.
const GENERATED = {
    admin_password: 'Seeded-admin-e2e-0123456789',
    api_admin_password: 'e2e-only-api-admin-0123456789abcdef',
    secret_key_base: 'e2e-only-secret-key-base-0123456789abcdef',
};
const DB = { name: 'openproject', user: 'openproject', password: 'op-e2e' };
// OpenProject's seeder writes its demo project's pictures to the object store
// and fails without one, so the run has one: the image the platform runs.
const S3_IMAGE = process.env.E2E_S3_IMAGE || 'docker.io/bitnamilegacy/minio:2025.4.22-debian-12-r1';
const S3 = { bucket: 'openproject-e2e', accessKey: 'openproject-e2e', secretKey: 'e2e-only-s3-secret-0123456789' };

const ANNA = { email: 'anna@acme.e2e.test', firstName: 'Anna', lastName: "O'Example", password: 'pw-anna-e2e', subject: 'sub-anna', name: "Anna O'Example" };
const BEN = { email: 'ben@acme.e2e.test', firstName: 'Ben', lastName: 'Example', password: 'pw-ben-e2e', subject: 'sub-ben', name: 'Ben Example' };
const CARLA = { email: 'carla@acme.e2e.test', firstName: 'Carla', lastName: 'Example', password: 'pw-carla-e2e', subject: 'sub-carla', name: 'Carla Example' };
const ERIK = { email: 'erik@acme.e2e.test', firstName: 'Erik', lastName: 'Example', password: 'pw-erik-e2e', subject: 'sub-erik', name: 'Erik Example' };
// A person at the platform who holds the address of the administrator
// OpenProject seeds.
const SEEDED = { email: `openproject-admin@${DOMAIN}`, firstName: 'Dora', lastName: 'Example', password: 'pw-dora-e2e', subject: 'sub-dora', name: 'Dora Example' };

let kc;
let sidecar;
let appUpstream;
let chart;
const names = { pg: 'sso-e2e-op-pg', cache: 'sso-e2e-op-cache', s3: 'sso-e2e-op-s3', seeder: 'sso-e2e-op-seeder', app: 'sso-e2e-op', sidecar: 'sso-e2e-op-sidecar' };

function psql(sql) {
    return setup.docker('exec', names.pg, 'psql', '-U', DB.user, '-d', DB.name, '-At', '-c', sql);
}

function setPath(values, dotted, value) {
    const keys = dotted.split('.');
    let node = values;
    for (const key of keys.slice(0, -1)) {
        if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
        node = node[key];
    }
    node[keys[keys.length - 1]] = value;
}

// The chart the profile names, rendered with the values the platform would
// give it: the profile's extraValues with its placeholders filled in, what it
// maps from the platform's services, and its generated secrets. Answers the
// image and the environment of the chart's web pod, and the seeder's command.
function chartRuntime() {
    const profile = YAML.parse(fs.readFileSync(path.join(REPO, PROFILE_DIR, 'profile.yaml'), 'utf8'));
    const pkg = profile.spec.package;
    const raw = JSON.stringify(pkg.extraValues)
        .replaceAll('${TENANT_DOMAIN}', DOMAIN)
        .replaceAll('${TENANT_ID}', REALM)
        .replaceAll('${TENANT_NAMESPACE}', 'tenant-acme')
        .replaceAll('${APP_ID}', 'openproject-ce')
        .replaceAll('${KERNEL_DOMAIN}', 'e2e.test');
    assert.ok(!raw.includes('${'), 'the profile uses a placeholder this run does not know');
    const values = JSON.parse(raw);
    const mapped = {
        database: { hostKey: names.pg, portKey: '5432', nameKey: DB.name, userKey: DB.user, passwordKey: DB.password },
        s3: { endpointKey: `http://${names.s3}:9000`, bucketKey: S3.bucket, accessKeyKey: S3.accessKey, regionKey: 'us-east-1', secretKeyKey: S3.secretKey },
        smtp: { hostKey: 'smtp.invalid', portKey: '587', userKey: 'e2e', passwordKey: 'e2e-smtp' },
    };
    for (const [service, keys] of Object.entries(pkg.valueMapping || {})) {
        for (const [key, target] of Object.entries(keys)) {
            assert.ok(mapped[service] && mapped[service][key] !== undefined, `the profile maps ${service}.${key}, which this run does not supply`);
            setPath(values, target, mapped[service][key]);
        }
    }
    for (const secret of profile.spec.secrets.generated) {
        assert.ok(GENERATED[secret.name], `the profile generates ${secret.name}, which this run does not supply`);
        setPath(values, secret.valuePath, GENERATED[secret.name]);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sso-e2e-op-chart-'));
    fs.writeFileSync(path.join(dir, 'values.yaml'), JSON.stringify(values));
    const rendered = execFileSync('helm', ['template', 'openproject-ce', pkg.chart.name, '--repo', pkg.chart.repository,
        '--version', pkg.chart.version, '--namespace', 'tenant-acme', '-f', path.join(dir, 'values.yaml')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    fs.rmSync(dir, { recursive: true, force: true });

    const docs = YAML.parseAllDocuments(rendered).map((d) => d.toJS()).filter(Boolean);
    const secrets = Object.fromEntries(docs.filter((d) => d.kind === 'Secret').map((d) => [d.metadata.name, d.stringData || {}]));
    const container = (kind, component) => {
        const doc = docs.find((d) => d.kind === kind && d.metadata.name.endsWith(component));
        assert.ok(doc, `the chart renders no ${kind} ${component}`);
        return { pod: doc.spec.template, container: doc.spec.template.spec.containers[0] };
    };
    const environment = ({ container: c }) => {
        const env = {};
        for (const from of c.envFrom || []) Object.assign(env, secrets[from.secretRef.name]);
        for (const e of c.env || []) if (e.value !== undefined) env[e.name] = String(e.value);
        return env;
    };
    // How the chart confines the container: the user it runs as, a read-only
    // file system with the chart's writable mounts, and its memory limit.
    const confinement = ({ container: c }) => {
        const sc = c.securityContext || {};
        const args = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];
        if (sc.runAsUser !== undefined) args.push('--user', `${sc.runAsUser}:${sc.runAsGroup ?? sc.runAsUser}`);
        if (sc.readOnlyRootFilesystem) {
            args.push('--read-only');
            for (const mount of c.volumeMounts || []) args.push('--tmpfs', `${mount.mountPath}:mode=1777`);
        }
        const memory = /^(\d+)(Mi|Gi)$/.exec((c.resources && c.resources.limits && c.resources.limits.memory) || '');
        if (memory) args.push('--memory', `${memory[1]}${memory[2] === 'Gi' ? 'g' : 'm'}`);
        return args;
    };
    const web = container('Deployment', '-web');
    const seeder = docs.find((d) => d.kind === 'Job');
    assert.ok(seeder, 'the chart renders no seeder job');
    const seed = { pod: seeder.spec.template, container: seeder.spec.template.spec.containers[0] };
    return {
        image: web.container.image,
        labels: web.pod.metadata.labels,
        web: { env: environment(web), args: web.container.args, confinement: confinement(web) },
        seeder: { env: environment(seed), args: seed.container.args, confinement: confinement(seed), annotations: seeder.metadata.annotations || {} },
    };
}

function envArgs(env) {
    return Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
}

before(async () => {
    chart = chartRuntime();
    kc = await setup.startKeycloak();
    await setup.ensureRealm(kc, REALM, [ANNA, BEN, CARLA, ERIK, SEEDED]);
    await setup.ensureSidecarClient(kc, REALM, HOST, { logoutUrl: setup.logoutUrlOf(names.sidecar) });
    for (const person of [ANNA, BEN, CARLA, ERIK, SEEDED]) await setup.setAppAdmin(kc, REALM, person.email, false);
    for (const name of Object.values(names)) setup.removeSidecar(name);
    setup.docker('run', '-d', '--name', names.pg, '--network', setup.NETWORK,
        '-e', `POSTGRES_USER=${DB.user}`, '-e', `POSTGRES_PASSWORD=${DB.password}`, '-e', `POSTGRES_DB=${DB.name}`, 'postgres:16-alpine');
    // Under the name the profile gives its cache.
    setup.docker('run', '-d', '--name', names.cache, '--network', setup.NETWORK, '--network-alias', 'memcached', 'memcached:1.6-alpine');
    setup.docker('run', '-d', '--name', names.s3, '--network', setup.NETWORK,
        '-e', `MINIO_ROOT_USER=${S3.accessKey}`, '-e', `MINIO_ROOT_PASSWORD=${S3.secretKey}`, '-e', `MINIO_DEFAULT_BUCKETS=${S3.bucket}`, S3_IMAGE);
    await setup.waitFor('the object store', async () => setup.tryDocker('exec', names.s3, 'sh', '-c', `ls /bitnami/minio/data/${S3.bucket} >/dev/null 2>&1 && echo there`) === 'there', 90);
    await setup.waitFor('PostgreSQL', async () => setup.tryDocker('exec', names.pg, 'pg_isready', '-U', DB.user) !== '', 60);
    // The chart's seeder job, then its web pod: the same image, each with the
    // environment and the command the chart gives it.
    execFileSync('docker', ['run', '--name', names.seeder, '--network', setup.NETWORK, ...chart.seeder.confinement, ...envArgs(chart.seeder.env), chart.image, ...chart.seeder.args],
        { stdio: 'ignore', timeout: 15 * 60 * 1000 });
    setup.docker('run', '-d', '--name', names.app, '--network', setup.NETWORK, '-p', '127.0.0.1::8080',
        ...chart.web.confinement, ...envArgs(chart.web.env), chart.image, ...chart.web.args);
    appUpstream = `http://127.0.0.1:${setup.publishedPort(names.app, 8080)}`;
    await setup.waitFor('OpenProject', async () => (await setup.call('GET', `${appUpstream}/health_checks/default`, { headers: { host: HOST, 'x-forwarded-proto': 'https' } })).status === 200, 420);
    sidecar = setup.startSidecar({
        name: names.sidecar, host: HOST, realm: REALM, kc, handlerFile: HANDLER,
        env: {
            DB_HOST: names.pg, DB_PORT: '5432', DB_NAME: DB.name, DB_USER: DB.user, DB_PASSWORD: DB.password,
            SECRET_SECRET_KEY_BASE: GENERATED.secret_key_base, SECRET_API_ADMIN_PASSWORD: GENERATED.api_admin_password,
            APP_URL: `http://${names.app}:8080`,
        },
    });
    await setup.sidecarReady(sidecar);
});

after(() => {
    if (process.env.E2E_KEEP) return;
    for (const name of Object.values(names)) setup.removeSidecar(name);
});

function browserAs(door) {
    return new Browser({
        [setup.IDP_HOST]: keycloak(kc.upstream),
        [HOST]: frontDoor({ door, sidecar: sidecar.upstream, app: appUpstream, realm: REALM, entryPaths: ENTRY_PATHS, denyPaths: DENY_PATHS }),
    });
}

async function signIn(person) {
    const browser = browserAs({ person });
    const res = await browser.navigate(`https://${HOST}/`, { credentials: { username: person.email, password: person.password } });
    return { browser, res };
}

// Who OpenProject says the browser is.
async function whoAmI(browser) {
    const res = await browser.request('GET', `https://${HOST}/api/v3/users/me`);
    return { status: res.status, user: res.status === 200 ? JSON.parse(res.body) : null };
}

// What OpenProject's database says of an account: OpenProject tells only an
// administrator who is one.
function account(person) {
    const [status, admin] = psql(`select status, admin from users where type = 'User' and lower(mail) = '${person.email}'`).split('|');
    return { status: Number(status), admin: admin === 't' };
}

// Refused: no session of the sidecar's making, and OpenProject knows nobody.
// (OpenProject gives every browser a cookie of that name; the sidecar's is
// the one with a lifetime.)
async function assertNotSignedIn(browser, res) {
    assert.equal(res.status, 403, browser.log.join(' -> '));
    const cookie = browser.cookie(HOST, '_open_project_session');
    assert.ok(!cookie || !/Max-Age/.test(cookie.raw), cookie && cookie.raw);
    assert.equal((await whoAmI(browser)).status, 401);
}

// OpenProject's own interface, as the service account the profile configures.
function serviceAccount(method, pathAndQuery, json) {
    return setup.call(method, `${appUpstream}${pathAndQuery}`, {
        headers: {
            host: HOST, 'x-forwarded-proto': 'https', 'content-type': 'application/json',
            authorization: 'Basic ' + Buffer.from(`${chart.web.env.OPENPROJECT_AUTHENTICATION_GLOBAL__BASIC__AUTH_USER}:${GENERATED.api_admin_password}`).toString('base64'),
        },
        body: json === undefined ? undefined : JSON.stringify(json),
    });
}

test('the chart gives OpenProject what the profile says: the pinned image, a key of its own, no password sign-in', () => {
    assert.match(chart.image, /^docker\.io\/openproject\/openproject:\d+\.\d+\.\d+-slim$/);
    assert.equal(chart.web.env.SECRET_KEY_BASE, GENERATED.secret_key_base);
    assert.equal(chart.web.env.OPENPROJECT_DISABLE__PASSWORD__LOGIN, 'true');
    assert.equal(chart.web.env.OPENPROJECT_AUTOLOGIN, '1');
    assert.equal(chart.web.env.OPENPROJECT_HOST__NAME, HOST);
    assert.equal(chart.seeder.env.OPENPROJECT_SEED_ADMIN_USER_LOCKED, 'true');
    // The switches the old bridge needed are gone, and nothing of OpenProject's
    // paid single sign-on is configured.
    for (const key of Object.keys(chart.web.env)) assert.doesNotMatch(key, /2FA|OPENID|OMNIAUTH|ENTERPRISE|SAML|AUTH__SOURCE__SSO/);
    // The seeder is a Job of the release and no hook: a hook would run only
    // after the wait for the web pod, which waits for the seeder.
    assert.equal(chart.seeder.annotations['helm.sh/hook'], undefined);
    assert.ok(chart.web.confinement.includes('--read-only'));
    // The labels the platform finds the app's pods by.
    assert.equal(chart.labels['gentianos.io/app'], 'openproject-ce');
    assert.equal(chart.labels['gentianos.io/tenant'], REALM);
});

test('the first person to open OpenProject is in, as an ordinary account', async () => {
    const { browser, res } = await signIn(ANNA);
    assert.equal(res.status, 200, browser.log.join(' -> '));
    assert.equal(new URL(res.url).pathname, '/');
    // OpenProject sent the browser to its own sign-in page, and the platform
    // sent it on from there.
    assert.ok(browser.log.includes(`GET ${HOST}/login`), browser.log.join(' -> '));

    const cookie = browser.cookie(HOST, '_open_project_session');
    assert.match(cookie.raw, /; Path=\/; Max-Age=\d+; Secure; SameSite=Lax; HttpOnly$/);
    // The token that made the session was never the browser's.
    assert.equal(browser.cookie(HOST, 'autologin'), undefined);

    const me = await whoAmI(browser);
    assert.equal(me.status, 200);
    assert.equal(me.user.email, ANNA.email);
    assert.equal(me.user.login, ANNA.email);
    assert.equal(me.user.name, ANNA.name);
    assert.deepEqual(account(ANNA), { status: 1, admin: false });
});

test('a session that is used keeps the lifetime the sidecar gave its cookie', async () => {
    const { browser } = await signIn(ANNA);
    const before = browser.cookie(HOST, '_open_project_session').raw;
    for (const p of ['/', '/my/account', '/my/sessions', '/projects']) {
        const res = await browser.request('GET', `https://${HOST}${p}`);
        assert.equal(res.status, 200, p);
    }
    assert.equal(browser.cookie(HOST, '_open_project_session').raw, before);
});

test('nobody has a password, and the administrator OpenProject seeds is locked', () => {
    assert.equal(psql("select count(*) from user_passwords p join users u on u.id = p.user_id where u.login <> 'admin'"), '0');
    // status 3 is locked.
    assert.equal(psql("select status, admin from users where login = 'admin'"), '3|t');
    assert.equal(psql("select count(*) from users where type = 'User' and admin and status = 1"), '0');
});

test('the token is spent at once, and the session ends when the sidecar said it would', async () => {
    const tokens = psql(`select t.value like 'spent:%', extract(epoch from (t.expires_on - now()))::int from tokens t join users u on u.id = t.user_id where t.type = 'Token::AutoLogin' and u.mail = '${ANNA.email}'`).split('\n');
    assert.ok(tokens.length >= 1);
    for (const line of tokens) {
        const [spent, left] = line.split('|');
        assert.equal(spent, 't');
        assert.ok(Number(left) > 3000 && Number(left) <= 3600, left);
    }
    // Every session of a person is linked to the token it was made from.
    assert.equal(psql('select count(*) from sessions s where s.user_id is not null and not exists (select 1 from autologin_session_links l where l.session_id = s.id)'), '0');

    // When a token has run out its session is gone at the next sign-in of
    // anybody, and within the minute otherwise.
    const { browser } = await signIn(CARLA);
    assert.equal((await whoAmI(browser)).status, 200);
    psql(`update tokens set expires_on = now() - interval '1 second' where type = 'Token::AutoLogin' and user_id = (select id from users where mail = '${CARLA.email}')`);
    await signIn(ANNA);
    assert.equal((await whoAmI(browser)).status, 401);
    assert.equal(psql(`select count(*) from sessions where user_id = (select id from users where mail = '${CARLA.email}')`), '0');
    assert.equal(psql(`select count(*) from tokens where type = 'Token::AutoLogin' and user_id = (select id from users where mail = '${CARLA.email}')`), '0');
});

test('a second person gets an account of their own', async () => {
    const { browser, res } = await signIn(BEN);
    assert.equal(new URL(res.url).pathname, '/', browser.log.join(' -> '));
    const me = await whoAmI(browser);
    assert.equal(me.user.email, BEN.email);
    assert.deepEqual(account(BEN), { status: 1, admin: false });
    assert.equal(psql(`select count(*) from users where type = 'User' and mail in ('${ANNA.email}', '${BEN.email}')`), '2');
});

test('opening the app again makes no second account and asks for nothing', async () => {
    const { browser } = await signIn(ANNA);
    browser.log.length = 0;
    const res = await browser.navigate(`https://${HOST}/`);
    assert.equal(res.status, 200);
    assert.equal(new URL(res.url).pathname, '/');
    // With a session, OpenProject's front page is OpenProject's: no sign-in.
    assert.deepEqual(browser.log, [`GET ${HOST}/`]);

    // Without one -- the hour is over, the browser has dropped the cookie --
    // the person is taken through the sign-in and meets no form.
    browser.jar = browser.jar.filter((c) => !(c.host === HOST && c.name === '_open_project_session'));
    browser.log.length = 0;
    const again = await browser.navigate(`https://${HOST}/projects`);
    assert.equal(again.status, 200, browser.log.join(' -> '));
    assert.ok(browser.log.includes(`GET ${HOST}/sso/login`));
    assert.ok(!browser.log.some((line) => line.includes('login-actions')), browser.log.join(' -> '));
    assert.equal((await whoAmI(browser)).user.email, ANNA.email);
    assert.equal(psql(`select count(*) from users where mail = '${ANNA.email}'`), '1');
});

test('OpenProject\'s own sign-in takes no password, at the front door or behind it', async () => {
    const browser = browserAs({ person: ANNA });
    const page = await browser.request('GET', `https://${HOST}/login`);
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/sso/login');
    for (const p of DENY_PATHS) {
        const res = await browser.request('POST', `https://${HOST}${p}`, { form: { username: 'admin', password: GENERATED.admin_password } });
        assert.equal(res.status, 403, p);
    }

    // Behind the front door: OpenProject's own page has no form, and a
    // password posted to it the way its form would -- with the page's own
    // token against forged requests -- is answered 404. The administrator's
    // password is the right one, and unlocking the account changes nothing.
    psql("update users set status = 1 where login = 'admin'");
    try {
        const direct = new Browser({ [HOST]: () => ({ upstream: appUpstream }) });
        const form = await direct.request('GET', `https://${HOST}/login`);
        assert.equal(form.status, 200);
        assert.doesNotMatch(form.body, /name="password"/);
        const csrf = /<meta name="csrf-token" content="([^"]+)"/.exec(form.body);
        assert.ok(csrf, 'the page carries no token against forged requests');
        const posted = await direct.request('POST', `https://${HOST}/login`, { form: { authenticity_token: csrf[1], username: 'admin', password: GENERATED.admin_password } });
        assert.equal(posted.status, 404);
        const me = await direct.request('GET', `https://${HOST}/api/v3/users/me`);
        assert.equal(me.status, 401);
        // The same request through the front door reaches the same answer:
        // only a page load of /login is sent to the sign-in.
        const through = await browser.request('POST', `https://${HOST}/login`, { form: { username: 'admin', password: GENERATED.admin_password } });
        assert.ok([404, 422].includes(through.status), String(through.status));
    } finally {
        psql("update users set status = 3 where login = 'admin'");
    }
});

test('a person who holds the seeded administrator\'s address is not signed in as it', async () => {
    const { browser, res } = await signIn(SEEDED);
    await assertNotSignedIn(browser, res);
    assert.equal(psql(`select count(*) from users where lower(mail) = '${SEEDED.email}'`), '1');
});

test('an account locked in OpenProject is not signed in', async () => {
    psql(`update users set status = 3 where mail = '${BEN.email}'`);
    try {
        const { browser, res } = await signIn(BEN);
        await assertNotSignedIn(browser, res);
    } finally {
        psql(`update users set status = 1 where mail = '${BEN.email}'`);
    }
});

test('signing out in OpenProject ends the session there', async () => {
    const { browser } = await signIn(BEN);
    const session = browser.cookie(HOST, '_open_project_session').value;
    assert.equal((await whoAmI(browser)).status, 200);
    const out = await browser.request('GET', `https://${HOST}/logout`);
    assert.ok([302, 303].includes(out.status), String(out.status));
    // The cookie itself, presented again, is nobody's.
    const again = await setup.call('GET', `${appUpstream}/api/v3/users/me`, {
        headers: { host: HOST, 'x-forwarded-proto': 'https', cookie: `_open_project_session=${session}` },
    });
    assert.equal(again.status, 401);
});

// Signing out at the platform. The realm tells the sidecar, and the handler
// ends the person's sessions in OpenProject.

// The cookie as a browser would go on presenting it, straight to OpenProject.
async function sessionStatus(session) {
    const res = await setup.call('GET', `${appUpstream}/api/v3/users/me`, {
        headers: { host: HOST, 'x-forwarded-proto': 'https', cookie: `_open_project_session=${session}` },
    });
    return res.status;
}

test('signing out at the platform ends the person\'s session in OpenProject, and nobody else\'s', async () => {
    const anna = (await signIn(ANNA)).browser;
    const ben = (await signIn(BEN)).browser;
    const annaSession = anna.cookie(HOST, '_open_project_session').value;
    const benSession = ben.cookie(HOST, '_open_project_session').value;
    assert.equal(await sessionStatus(annaSession), 200);
    assert.equal(await sessionStatus(benSession), 200);

    const posted = (await setup.signOutPosts(sidecar)).length;
    await setup.signOutAtRealm(anna, REALM);
    const posts = await setup.waitForSignOut(sidecar, posted + 1);
    assert.equal(posts.length, posted + 1, 'the realm told the sidecar once');
    assert.equal(posts[posts.length - 1].status, 200);
    assert.equal(posts[posts.length - 1].host, sidecar.service.host);

    // Her cookie, which has most of its hour left, is nobody's: the next
    // person at this browser is not her.
    assert.equal(await sessionStatus(annaSession), 401);
    assert.equal((await whoAmI(anna)).status, 401);
    const annaId = `(select id from users where type = 'User' and lower(mail) = '${ANNA.email}')`;
    assert.equal(psql(`select count(*) from sessions where user_id = ${annaId}`), '0');
    assert.equal(psql(`select count(*) from tokens where type = 'Token::AutoLogin' and user_id = ${annaId}`), '0');
    // Ben is where he was.
    assert.equal(await sessionStatus(benSession), 200);
    assert.equal((await whoAmI(ben)).user.email, BEN.email);

    // Opening OpenProject again leads to the realm, which asks who she is.
    const again = await anna.navigate(`https://${HOST}/`);
    assert.match(again.body, /kc-form-login/);
});

test('a sign-out the realm did not send, or sent before, ends no session in OpenProject', async () => {
    const ben = (await signIn(BEN)).browser;
    const session = ben.cookie(HOST, '_open_project_session').value;
    await refusedSignOuts(sidecar, { realm: REALM, email: BEN.email });
    assert.equal(await sessionStatus(session), 200);
});

test('an account somebody in OpenProject invited the person to becomes theirs', async () => {
    const invited = ERIK;
    const made = await serviceAccount('POST', '/api/v3/users', { email: invited.email, status: 'invited' });
    assert.equal(made.status, 201, made.body);
    assert.equal(psql(`select status from users where mail = '${invited.email}'`), '4');
    const { browser, res } = await signIn(invited);
    assert.equal(res.status, 200, browser.log.join(' -> '));
    const me = await whoAmI(browser);
    assert.equal(me.user.email, invited.email);
    assert.equal(me.user.name, invited.name);
    assert.deepEqual(account(invited), { status: 1, admin: false });
    assert.equal(psql(`select count(*) from tokens t join users u on u.id = t.user_id where u.mail = '${invited.email}' and t.type = 'Token::Invitation'`), '0');
});

// Who administers OpenProject: who holds the platform's App Admin role, and
// nobody else.

// OpenProject's list of all accounts, which only an administrator sees.
async function mayAdminister(browser) {
    const page = await browser.request('GET', `https://${HOST}/users`);
    assert.ok([200, 403].includes(page.status), `the list of accounts answered ${page.status}`);
    return page.status === 200;
}

test('a person who holds the App Admin role administers OpenProject, and nobody else does', async () => {
    await setup.setAppAdmin(kc, REALM, BEN.email, true);
    const ben = await signIn(BEN);
    assert.equal(new URL(ben.res.url).pathname, '/', ben.browser.log.join(' -> '));
    assert.equal((await whoAmI(ben.browser)).user.admin, true);
    assert.equal(await mayAdminister(ben.browser), true);
    // Nobody else became one: not the first person in, not anybody.
    assert.equal(psql("select string_agg(mail, ',') from users where type = 'User' and admin and status = 1"), BEN.email);
    const anna = await signIn(ANNA);
    assert.equal((await whoAmI(anna.browser)).user.email, ANNA.email);
    assert.equal(await mayAdminister(anna.browser), false);
    assert.deepEqual(account(ANNA), { status: 1, admin: false });
    // The administrator OpenProject seeds is as it was: locked.
    assert.equal(psql("select status, admin from users where login = 'admin'"), '3|t');
});

test('signing in again as the administrator one already is changes nothing', async () => {
    const made = () => (setup.logsOf(names.sidecar).match(/administrator-made/g) || []).length;
    const before = made();
    assert.equal(before, 1);
    const ben = await signIn(BEN);
    assert.equal((await whoAmI(ben.browser)).user.admin, true);
    assert.equal(made(), before);
});

test('withdrawing the role takes it away in OpenProject at the next sign-in', async () => {
    const before = await signIn(BEN);
    assert.equal(await mayAdminister(before.browser), true);
    await setup.setAppAdmin(kc, REALM, BEN.email, false);
    const after = await signIn(BEN);
    assert.equal(new URL(after.res.url).pathname, '/', after.browser.log.join(' -> '));
    assert.deepEqual(account(BEN), { status: 1, admin: false });
    assert.equal(await mayAdminister(after.browser), false);
    // The session he still had from before is no administrator's either.
    assert.equal(await mayAdminister(before.browser), false);
    // He was the only active administrator, and OpenProject's own interface
    // does not take the flag from the last one: it is taken all the same.
    assert.equal(psql("select count(*) from users where type = 'User' and admin and status = 1"), '0');
});

test('one of two administrators loses the role through OpenProject\'s own interface', async () => {
    await setup.setAppAdmin(kc, REALM, BEN.email, true);
    await setup.setAppAdmin(kc, REALM, CARLA.email, true);
    for (const person of [BEN, CARLA]) assert.equal(await mayAdminister((await signIn(person)).browser), true);
    await setup.setAppAdmin(kc, REALM, CARLA.email, false);
    assert.equal(await mayAdminister((await signIn(CARLA)).browser), false);
    assert.equal(psql("select string_agg(mail, ',') from users where type = 'User' and admin and status = 1"), BEN.email);
    await setup.setAppAdmin(kc, REALM, BEN.email, false);
    assert.equal(await mayAdminister((await signIn(BEN)).browser), false);
});

test('an administrator made inside OpenProject who does not hold the role is one until the next sign-in', async () => {
    const id = psql(`select id from users where mail = '${ANNA.email}'`);
    const granted = await serviceAccount('PATCH', `/api/v3/users/${id}`, { admin: true });
    assert.equal(granted.status, 200, granted.body);
    assert.deepEqual(account(ANNA), { status: 1, admin: true });
    const anna = await signIn(ANNA);
    assert.deepEqual(account(ANNA), { status: 1, admin: false });
    assert.equal(await mayAdminister(anna.browser), false);
});

test('nothing a browser sends makes an administrator of OpenProject', async () => {
    const browser = browserAs({ person: ANNA });
    const request = browser.request.bind(browser);
    const claims = { 'x-gentian-app-admin': 'true', 'x-gentian-roles': setup.APP_ADMIN_ROLE, role: 'admin' };
    browser.request = (method, url, options = {}) => request(method, url, { ...options, headers: { ...(options.headers || {}), ...claims } });
    const res = await browser.navigate(`https://${HOST}/?appAdmin=true`, { credentials: { username: ANNA.email, password: ANNA.password } });
    assert.equal(new URL(res.url).pathname, '/', browser.log.join(' -> '));
    assert.deepEqual(account(ANNA), { status: 1, admin: false });
    assert.equal(await mayAdminister(browser), false);
    // OpenProject's own call for it is not an ordinary account's to make.
    const id = psql(`select id from users where mail = '${ANNA.email}'`);
    const self = await browser.request('PATCH', `https://${HOST}/api/v3/users/${id}`, { json: { admin: true }, headers: { 'x-requested-with': 'XMLHttpRequest' } });
    assert.ok(self.status >= 400, `changing one's own account answered ${self.status}`);
    assert.deepEqual(account(ANNA), { status: 1, admin: false });
});

test('the sidecar\'s log names nobody', () => {
    const logs = setup.logsOf(names.sidecar);
    assert.match(logs, /"event":"signed-in"/);
    assert.match(logs, /"event":"signed-out"/);
    assert.doesNotMatch(logs, /anna|ben@|carla|erik|Example|openproject-admin/i);
});
