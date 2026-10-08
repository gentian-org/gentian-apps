'use strict';

// One line of JSON per event. What is written says what happened to a
// sign-in and why one was refused. It never names the person: no address, no
// name, no assertion, no cookie and no token is logged here, and a handler is
// given the same function with the same rule.

function write(level, event, fields) {
    const line = { time: new Date().toISOString(), level, event };
    for (const [key, value] of Object.entries(fields || {})) {
        if (value !== undefined) line[key] = value;
    }
    process.stdout.write(JSON.stringify(line) + '\n');
}

module.exports = {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
};
