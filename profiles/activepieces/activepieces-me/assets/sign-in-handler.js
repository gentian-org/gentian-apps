'use strict';

// Sign-in handler for Activepieces (community edition), run by the platform's
// sign-in sidecar. See customization.md beside this file for the review.
//
// Activepieces' own single sign-on is a paid feature and is not used or
// touched here. What the free edition has is an account per person and a
// session that is a token signed with the installation's AP_JWT_SECRET, kept
// by its web page in the browser's localStorage. This handler makes exactly
// that, for the person the sidecar names:
//
//   1. the platform, if this is the first sign-in ever: Activepieces' own
//      first sign-up, which creates it with the edition's own settings. No
//      row of the platform table is written here, and none of its switches.
//   2. the person's account and the project they work in, if they have none.
//      Written to the database: the free edition's own interface makes an
//      account for a second person only by invitation and gives that account
//      no project (see customization.md, "What the handler writes itself").
//   3. a token for that account and project, ending when the sidecar says
//      the session ends.
//
// Every person is an ordinary member. Nobody is an administrator of the
// installation, and nobody has a password: the column cannot be empty of a
// value, so it holds the empty string, which no password matches.
//
// What it is given (see the profile's requires.services.identity.sidecar):
//   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD   Activepieces' own database
//   SECRET_JWT_SECRET                                 its signing key
//   APP_URL                                           Activepieces inside the cluster

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

// The account the platform is created with. Activepieces has no service
// account, so it is listed among the users; nobody can sign in as it.
const OWNER = { email: 'config-account@activepieces.internal', firstName: 'Config', lastName: 'Account' };

const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 4,
    connectionTimeoutMillis: 5000,
});

// An identifier as Activepieces makes them: 21 characters of this alphabet.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function newId() {
    let id = '';
    while (id.length < 21) {
        // 248 is the largest multiple of 62 a byte can reach: no letter is likelier than another.
        for (const byte of crypto.randomBytes(32)) {
            if (byte < 248 && id.length < 21) id += ALPHABET[byte % 62];
        }
    }
    return id;
}

function names(person) {
    const parts = person.name.trim().split(/\s+/).filter(Boolean);
    const first = (parts.shift() || person.email.split('@')[0]).slice(0, 100);
    return { firstName: first, lastName: (parts.join(' ') || '-').slice(0, 100) };
}

async function ensurePlatform() {
    const found = await pool.query('select id from platform order by created asc limit 1');
    if (found.rows.length > 0) return found.rows[0].id;
    // The first sign-up of an installation creates its platform. The password
    // is random, is kept nowhere, and is taken out of the row again below.
    const res = await fetch(process.env.APP_URL + '/api/v1/authentication/sign-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...OWNER, password: crypto.randomBytes(32).toString('base64url'), trackEvents: false, newsLetter: false }),
        signal: AbortSignal.timeout(15000),
    });
    const made = await pool.query('select id from platform order by created asc limit 1');
    if (made.rows.length === 0) throw new Error(`creating the platform answered ${res.status}`);
    await pool.query('update "user" set password = \'\' where "platformId" = $1 and lower(email) = $2', [made.rows[0].id, OWNER.email]);
    return made.rows[0].id;
}

async function findUser(platformId, email) {
    const found = await pool.query(
        'select id, email, "firstName", "lastName", status, verified, "platformRole" from "user" ' +
        'where "platformId" = $1 and lower(email) = $2 limit 1', [platformId, email]);
    return found.rows[0] || null;
}

async function createUser(platformId, person) {
    const { firstName, lastName } = names(person);
    const client = await pool.connect();
    try {
        await client.query('begin');
        const userId = newId();
        await client.query(
            'insert into "user" (id, email, "firstName", "lastName", password, status, verified, "trackEvents", "newsLetter", "platformRole", "platformId") ' +
            "values ($1, $2, $3, $4, '', 'ACTIVE', true, false, false, 'MEMBER', $5)",
            [userId, person.email, firstName, lastName, platformId]);
        await client.query(
            'insert into project (id, "ownerId", "displayName", "notifyStatus", "platformId") values ($1, $2, $3, \'ALWAYS\', $4)',
            [newId(), userId, `${firstName}'s Project`, platformId]);
        await client.query('commit');
    } catch (err) {
        await client.query('rollback');
        throw err;
    } finally {
        client.release();
    }
    return findUser(platformId, person.email);
}

// One account is made once, however many sign-ins of the same person arrive
// together. The sidecar is a single process.
const creating = new Map();

async function ensureUser(platformId, person) {
    const existing = await findUser(platformId, person.email);
    if (existing) return existing;
    if (!creating.has(person.email)) {
        creating.set(person.email, createUser(platformId, person).finally(() => creating.delete(person.email)));
    }
    return creating.get(person.email);
}

module.exports = {
    async onLogin(person, ctx) {
        const platformId = await ensurePlatform();
        const user = await ensureUser(platformId, person);
        // An account switched off in Activepieces stays off.
        if (!user || user.status !== 'ACTIVE') return { refuse: true };

        const project = await pool.query(
            'select id from project where "ownerId" = $1 and "platformId" = $2 and deleted is null order by created asc limit 1',
            [user.id, platformId]);
        if (project.rows.length === 0) return { refuse: true };
        const projectId = project.rows[0].id;

        // The token Activepieces signs itself, field for field
        // (authentication sign-in, 0.28.0), with the sidecar's end.
        const token = jwt.sign(
            { id: user.id, type: 'USER', projectId, platform: { id: platformId } },
            process.env.SECRET_JWT_SECRET,
            { algorithm: 'HS256', issuer: 'activepieces', keyid: '1', expiresIn: ctx.sessionSeconds });

        return {
            // Not "/": the platform sends "/" to the sign-in.
            redirect: '/flows',
            // Where Activepieces' page keeps its session. It reads nothing else.
            localStorage: {
                token,
                currentUser: JSON.stringify({
                    id: user.id,
                    email: user.email,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    verified: user.verified,
                    status: user.status,
                    platformRole: user.platformRole,
                    platformId,
                    projectId,
                    projectRole: 'ADMIN',
                    trackEvents: false,
                    newsLetter: false,
                    externalId: null,
                }),
            },
        };
    },
};
