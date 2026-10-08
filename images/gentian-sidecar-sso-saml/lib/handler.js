'use strict';

const crypto = require('crypto');
const fs = require('fs');

// The app's part: the one piece of code that knows how this app keeps a
// session.
//
// It comes from the app's catalogue entry and is named, by its sha256, in the
// sidecar's settings. A file that is not that file is not loaded, and without
// a handler the sidecar does not start: what runs here holds whatever the app
// handed the sidecar, so it is the reviewed file or nothing.
function loadHandler(path, digest) {
    let source;
    try {
        source = fs.readFileSync(path);
    } catch (err) {
        throw new Error(`the handler at ${path} cannot be read: ${err.code || err.message}`);
    }
    const actual = crypto.createHash('sha256').update(source).digest('hex');
    if (actual !== digest) {
        throw new Error(`the handler at ${path} is not the one this sidecar was told to run (sha256 ${actual})`);
    }
    const handler = require(path);
    if (!handler || typeof handler.onLogin !== 'function') {
        throw new Error(`the handler at ${path} exports no onLogin function`);
    }
    return handler;
}

module.exports = { loadHandler };
