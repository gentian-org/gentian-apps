'use strict';

// The rights store, as far as a sign-in asks it, run beside Keycloak in a
// container of its own: the roles a person holds on an app, answered to a
// question Keycloak signed with the key whose public half is at
// /stand-in/listener.pub. A question whose signature does not verify is
// refused, and the sign-in with it. Who holds what is set by the run:
//
//   PUT /holders/<tenant>/<app>/<person>      admin on that app ('*' = every app)
//   PUT /holders/<tenant>//<person>           admin on the tenant itself
//   DELETE the same                           taken again

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

const KEY_ID = process.env.KEY_ID || 'e2e';
const publicKey = crypto.createPublicKey(fs.readFileSync('/stand-in/listener.pub'));
const holders = new Set();

function answer(body) {
    const q = JSON.parse(body);
    const has = (app) => holders.has(`${q.tenant}/${app}/${q.person}`);
    return {
        apps: q.app ? [{ app: q.app, roles: has(q.app) || has('*') ? ['admin'] : [] }] : [],
        tenant: q.tenant && has('') ? ['admin', 'user'] : [],
        cluster: [],
    };
}

http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (req.url.startsWith('/holders/')) {
            const key = decodeURIComponent(req.url.slice('/holders/'.length));
            if (req.method === 'PUT') holders.add(key);
            else if (req.method === 'DELETE') holders.delete(key);
            res.writeHead(204).end();
            return;
        }
        const sig = /^keyid=([^,]+),t=(\d+),sig=(.+)$/.exec(req.headers['x-gentian-signature'] || '');
        if (req.method !== 'POST' || !sig || sig[1] !== KEY_ID ||
            !crypto.verify(null, Buffer.from(`${sig[2]}.${body}`), publicKey, Buffer.from(sig[3], 'base64'))) {
            res.writeHead(401).end();
            return;
        }
        try {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer(body)));
        } catch {
            res.writeHead(400).end();
        }
    });
}).listen(8080);
