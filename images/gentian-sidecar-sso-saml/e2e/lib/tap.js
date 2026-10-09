'use strict';

// Stands where a cluster has a Service: the name the realm calls when a
// person signs out -- the sidecar's, or the app's own for an app that signs
// people in itself. It passes every request on to the sidecar as it
// came, Host header included, and keeps what was posted, so that a run can
// present the realm's own request a second time.

const http = require('http');

const target = new URL(process.env.TAP_TARGET);
const posts = [];

http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/__posts') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(posts));
        return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const body = Buffer.concat(chunks);
        const out = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers }, (answer) => {
            const got = [];
            answer.on('data', (c) => got.push(c));
            answer.on('end', () => {
                if (req.method === 'POST') {
                    posts.push({ path: req.url, host: req.headers.host, contentType: req.headers['content-type'], body: body.toString('utf8'), status: answer.statusCode });
                }
                res.writeHead(answer.statusCode, answer.headers);
                res.end(Buffer.concat(got));
            });
        });
        out.on('error', () => {
            if (req.method === 'POST') posts.push({ path: req.url, host: req.headers.host, body: body.toString('utf8'), status: 0 });
            res.writeHead(502);
            res.end();
        });
        out.end(body);
    });
}).listen(parseInt(process.env.TAP_PORT || '8081', 10), '0.0.0.0');
