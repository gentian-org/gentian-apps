'use strict';

// Sign-in handler for OpenProject (community edition), run by the platform's
// sign-in sidecar. See customization.md beside this file for the review.
//
// OpenProject's own single sign-on (OIDC, SAML) is part of its paid edition
// and is not used or touched here. What the free edition has is an account
// per person, a session kept in its database and named by the cookie
// "_open_project_session", and a "stay signed in" token: a row of the table
// tokens that OpenProject turns into a session for the browser that presents
// its value in the cookie "autologin". This handler uses that token, once,
// and never shows it to a browser:
//
//   1. the person's account, if they have none: OpenProject's own interface
//      for making one (POST /api/v3/users), called inside the cluster as the
//      service account the profile configures. An ordinary account.
//   1a. who administers OpenProject: the person the sidecar says holds the
//      platform's App Admin role is made an administrator, and a person it
//      does not say so of is made an ordinary account again -- both through
//      OpenProject's own interface (PATCH /api/v3/users/<id>), as the same
//      service account, and only when the account is not already what it
//      should be. Nobody is an administrator for having been the first, or
//      for administering the tenant.
//   2. a token for that account, ending when the sidecar says the session
//      ends. Its value is made here and stored the way OpenProject stores
//      one: as a hash made with the installation's secret_key_base.
//   3. OpenProject's own sign-in with that token, inside the cluster. It
//      answers with the session cookie, and links the session to the token.
//   4. the token's stored hash is replaced, so that its value opens nothing
//      a second time. The row stays, as the record of when the session ends.
//   5. the browser is given the session cookie OpenProject made. No cookie is
//      forged, and the secret signs nothing.
//
// A session whose token has run out is deleted: at every sign-in and once a
// minute. OpenProject does the same when a token is destroyed through its own
// pages; it has no lifetime of its own for a session.
//
// Nobody has a password. OpenProject's interface demands one for a new
// account, so a random value is given and its stored hash is deleted again at
// once; the profile switches password sign-in off altogether.
//
// What it is given (see the profile's requires.services.identity.sidecar):
//   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD   OpenProject's own database
//   SECRET_SECRET_KEY_BASE                            what it hashes a token's value with
//   SECRET_API_ADMIN_PASSWORD                         its service account's password
//   APP_URL                                           OpenProject inside the cluster

const crypto = require('crypto');
const http = require('http');
const { Pool } = require('pg');

const SESSION_COOKIE = '_open_project_session';
const AUTOLOGIN_COOKIE = 'autologin';
const AUTOLOGIN_TOKEN = 'Token::AutoLogin';
// The service account's name, as the profile sets it
// (OPENPROJECT_AUTHENTICATION_GLOBAL__BASIC__AUTH_USER).
const API_USER = 'api_admin';
// users.status, as OpenProject numbers it (app/models/principal.rb).
const ACTIVE = 1;
const INVITED = 4;

const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 4,
    connectionTimeoutMillis: 5000,
});

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

// A request to OpenProject inside the cluster, told the public address it is
// asked under: it refuses a host it does not know, and sets its session
// cookie only for a request that arrived over TLS.
function app(method, path, origin, { headers = {}, json } = {}) {
    const target = new URL(path, process.env.APP_URL);
    const body = json === undefined ? null : JSON.stringify(json);
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: target.hostname,
            port: target.port || 80,
            method,
            path: target.pathname + target.search,
            timeout: 8000,
            headers: {
                ...headers,
                host: new URL(origin).host,
                'x-forwarded-proto': 'https',
                accept: 'application/json, text/html',
                ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
            },
        }, (res) => {
            // The answer's text is not read: it would name the person.
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
        });
        req.on('timeout', () => req.destroy(new Error('OpenProject did not answer in time')));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function names(person) {
    const parts = person.name.trim().split(/\s+/).filter(Boolean);
    const first = (parts.shift() || person.email.split('@')[0]).slice(0, 100);
    return { firstName: first, lastName: (parts.join(' ') || '-').slice(0, 100) };
}

async function findUser(email) {
    const found = await pool.query(
        "select id, status, admin from users where type = 'User' and lower(mail) = $1 order by id asc limit 2", [email]);
    // Two accounts under one address: OpenProject does not allow it, and
    // which of them the person is cannot be decided here.
    if (found.rows.length > 1) return { ambiguous: true };
    return found.rows[0] || null;
}

function serviceAccount() {
    return { authorization: 'Basic ' + Buffer.from(`${API_USER}:${process.env.SECRET_API_ADMIN_PASSWORD}`).toString('base64') };
}

// Who administers OpenProject is who holds the platform's App Admin role,
// and it is settled at every sign-in: given to a person who holds it, taken
// from a person who does not. person.appAdmin is the sidecar's reading of
// the realm's signed answer; a sidecar that does not say is one that says no.
// The session is made only once the account is what it should be, so a
// person the role was withdrawn from is not signed in as an administrator
// because a call failed.
async function settleAdministrator(user, person, origin) {
    const wanted = person.appAdmin === true;
    if (Boolean(user.admin) === wanted) return false;
    const is = async () => {
        const now = await pool.query("select admin from users where id = $1 and type = 'User'", [user.id]);
        return now.rows.length === 1 && Boolean(now.rows[0].admin) === wanted;
    };
    const res = await app('PATCH', `/api/v3/users/${user.id}`, origin, { headers: serviceAccount(), json: { admin: wanted } });
    if (await is()) return true;
    // OpenProject does not take the flag from its last active administrator:
    // it wants one to exist. Here one need not -- nobody administers a new
    // installation either, and the platform makes one whenever somebody is
    // given the role -- and a role that was withdrawn has to go. So for that
    // one case, and only for taking away, the flag is written.
    if (!wanted) {
        await pool.query("update users set admin = false, updated_at = now() where id = $1 and type = 'User'", [user.id]);
        if (await is()) return true;
    }
    throw new Error(`setting the administrator flag answered ${res.status}`);
}

async function createUser(person, origin) {
    const { firstName, lastName } = names(person);
    // Random, given to nobody, and deleted again below. The four characters
    // at the end are there for whatever rules the installation has set for a
    // password.
    const password = crypto.randomBytes(32).toString('base64url') + 'aZ9!';
    const res = await app('POST', '/api/v3/users', origin, {
        headers: serviceAccount(),
        json: { login: person.email, email: person.email, firstName, lastName, status: 'active', password },
    });
    const user = await findUser(person.email);
    if (!user || user.ambiguous) throw new Error(`creating the account answered ${res.status}`);
    await pool.query('delete from user_passwords where user_id = $1', [user.id]);
    return user;
}

// One account is made once, however many sign-ins of the same person arrive
// together. The sidecar is a single process.
const creating = new Map();

async function ensureUser(person, origin) {
    const existing = await findUser(person.email);
    if (existing) return existing;
    if (!creating.has(person.email)) {
        creating.set(person.email, createUser(person, origin).finally(() => creating.delete(person.email)));
    }
    return creating.get(person.email);
}

// An account somebody in OpenProject invited this address to: the person is
// who the invitation was for, so it is theirs now, with the name the
// platform knows them by. The invitation's own tokens are spent with it.
async function acceptInvitation(user, person) {
    const { firstName, lastName } = names(person);
    const done = await pool.query(
        'update users set status = $2, firstname = $3, lastname = $4, updated_at = now() where id = $1 and status = $5',
        [user.id, ACTIVE, firstName, lastName, INVITED]);
    await pool.query("delete from tokens where user_id = $1 and type = 'Token::Invitation'", [user.id]);
    return done.rowCount === 1;
}

// A session ends when its token has run out. OpenProject keeps the link
// between the two and deletes the session when the token is destroyed
// through its own pages; nothing in it destroys a token for having run out.
async function endExpiredSessions() {
    await pool.query(
        'delete from sessions where id in (select l.session_id from autologin_session_links l ' +
        'join tokens t on t.id = l.token_id where t.type = $1 and t.expires_on < now())', [AUTOLOGIN_TOKEN]);
    await pool.query('delete from tokens where type = $1 and expires_on < now()', [AUTOLOGIN_TOKEN]);
}
setInterval(() => endExpiredSessions().catch(() => {}), 60 * 1000).unref();

// The session cookie in an answer of OpenProject's, or ''.
function sessionIn(headers) {
    for (const line of headers['set-cookie'] || []) {
        const pair = line.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0 && pair.slice(0, eq).trim() === SESSION_COOKIE) return pair.slice(eq + 1).trim();
    }
    return '';
}

async function openSession(user, ctx) {
    const value = crypto.randomBytes(32).toString('hex');
    // As OpenProject stores a token (app/models/token/hashed_token.rb).
    const stored = sha256(value + process.env.SECRET_SECRET_KEY_BASE);
    const made = await pool.query(
        "insert into tokens (user_id, type, value, created_at, expires_on, data) " +
        "values ($1, $2, $3, now(), now() + make_interval(secs => $4), '{}') returning id",
        [user.id, AUTOLOGIN_TOKEN, stored, ctx.sessionSeconds]);
    const tokenId = made.rows[0].id;
    let session = '';
    try {
        // OpenProject's own sign-in page: for a browser with a valid token it
        // makes a session and answers with a redirect.
        const res = await app('GET', '/login', ctx.origin, { headers: { cookie: `${AUTOLOGIN_COOKIE}=${value}` } });
        // Spent, whatever was answered: no value matches this.
        await pool.query('update tokens set value = $2 where id = $1', [tokenId, 'spent:' + crypto.randomBytes(24).toString('hex')]);
        const candidate = sessionIn(res.headers);
        if (/^[0-9a-f]{16,128}$/.test(candidate)) {
            // The session OpenProject made is this person's, made from this
            // token: read back from its own tables, not taken on trust. A
            // session is stored under a hash of its cookie
            // (Rack::Session::SessionId#private_id).
            const check = await pool.query(
                'select s.user_id from sessions s join autologin_session_links l on l.session_id = s.id ' +
                'where l.token_id = $1 and s.session_id = $2', [tokenId, '2::' + sha256(candidate)]);
            if (check.rows.length === 1 && String(check.rows[0].user_id) === String(user.id)) session = candidate;
        }
        if (!session) throw new Error(`OpenProject made no session (${res.status})`);
        return session;
    } finally {
        if (!session) await pool.query('delete from tokens where id = $1', [tokenId]).catch(() => {});
    }
}

module.exports = {
    async onLogin(person, ctx) {
        await endExpiredSessions();

        let user = await ensureUser(person, ctx.origin);
        if (!user || user.ambiguous) return { refuse: true };
        if (user.status === INVITED && await acceptInvitation(user, person)) user = { ...user, status: ACTIVE };
        // An account locked in OpenProject stays locked, and one that waits
        // for an administrator's approval goes on waiting.
        if (user.status !== ACTIVE) return { refuse: true };

        if (await settleAdministrator(user, person, ctx.origin)) {
            ctx.log(person.appAdmin === true ? 'administrator-made' : 'administrator-unmade');
        }

        const session = await openSession(user, ctx);
        return {
            // OpenProject's front page. Not /login: the platform sends that
            // to the sign-in.
            redirect: '/',
            cookies: [{ name: SESSION_COOKIE, value: session }],
        };
    },
};
