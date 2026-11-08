'use strict';

// The realm's public address, inside the run's network: what the cluster's
// Gateway is to a pod that calls id.<domain>. It ends TLS with a certificate
// made for the run and passes the request on to Keycloak with the headers a
// proxy sets.

const fs = require('fs');
const http = require('http');
const https = require('https');

const target = new URL(process.env.FRONT_TARGET);
const host = process.env.FRONT_HOST;

https.createServer({ key: fs.readFileSync('/tls/key.pem'), cert: fs.readFileSync('/tls/cert.pem') }, (req, res) => {
    const out = http.request({
        host: target.hostname, port: target.port, method: req.method, path: req.url,
        headers: { ...req.headers, host, 'x-forwarded-proto': 'https', 'x-forwarded-host': host },
    }, (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
    });
    out.on('error', () => {
        res.writeHead(502);
        res.end();
    });
    req.pipe(out);
}).listen(443, '0.0.0.0');
