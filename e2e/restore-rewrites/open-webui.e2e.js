'use strict';

// Open WebUI (the profile's image) imported into another cluster under
// another domain: its volume comes back with the settings it stored at first
// start, which it prefers to the environment it is given here. Started again
// with this cluster's values it still names the old address and the old
// gateway connection; after the profile's post-restore commands it names the
// new ones, and a connection an administrator added is as it was.
//
//   e2e/restore-rewrites/run.sh open-webui

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const r = require('./lib/restore');

const PROFILE = r.profileOf('profiles/open-webui/open-webui-me');
const IMAGE = `ghcr.io/open-webui/open-webui:${PROFILE.spec.package.extraValues.image.tag}`;
const DATA = '/app/backend/data';

const OLD = { url: 'https://ai-chat.old.e2e.test', gateway: 'http://gateway.zrh-1.example/v1', key: 'old-gateway-key-0123456789' };
const NEW = { url: 'https://ai-chat.new.e2e.test', gateway: 'http://gateway.gva-2.example/v1', key: 'new-gateway-key-0123456789' };
const MINE = { url: 'https://models.elsewhere.example/v1', key: 'admins-own-key-0123456789' };

const names = { old: `${r.NETWORK}-owui-old`, app: `${r.NETWORK}-owui`, volume: `${r.NETWORK}-owui-data` };

function start(name, at) {
    r.tryDocker('rm', '-f', name);
    r.tryDocker('network', 'create', r.NETWORK);
    r.docker('run', '-d', '--name', name, '--network', r.NETWORK, '-v', `${names.volume}:${DATA}`,
        '-e', `WEBUI_URL=${at.url}`, '-e', `OPENAI_API_BASE_URL=${at.gateway}`, '-e', `OPENAI_API_KEY=${at.key}`,
        '-e', 'ENABLE_OLLAMA_API=false', '-e', 'OFFLINE_MODE=true', '-e', 'HF_HUB_OFFLINE=1', IMAGE);
}

function settings(container) {
    return JSON.parse(r.docker('exec', container, 'python3', '-c', `import json, sqlite3
c = sqlite3.connect("${DATA}/webui.db")
print(json.dumps({k: json.loads(v) if isinstance(v, (str, bytes)) else v for k, v in c.execute("SELECT key, value FROM config")}))`));
}

function setSetting(container, key, value) {
    r.docker('exec', container, 'python3', '-c', `import json, sqlite3, sys
c = sqlite3.connect("${DATA}/webui.db")
c.execute("UPDATE config SET value = ? WHERE key = ?", (sys.argv[2], sys.argv[1]))
c.commit()`, key, JSON.stringify(value));
}

before(async () => {
    r.cleanUp([names.old, names.app], [names.volume]);
    // Where the data was written: first start, settings stored, and a second
    // connection an administrator added.
    start(names.old, OLD);
    await r.waitFor('Open WebUI', () => settings(names.old)['webui.url'] === OLD.url, 300);
    setSetting(names.old, 'openai.api_base_urls', [OLD.gateway, MINE.url]);
    setSetting(names.old, 'openai.api_keys', [OLD.key, MINE.key]);
    r.docker('rm', '-f', names.old);
    // Where it is put back, resumed before the commands run.
    start(names.app, NEW);
    await r.waitFor('Open WebUI', () => r.docker('exec', names.app, 'curl', '-fs', 'http://127.0.0.1:8080/health').includes('true'), 300);
});

after(() => r.cleanUp([names.old, names.app], [names.volume]));

test('started with this cluster\'s values, it still prefers what it stored', () => {
    assert.equal(settings(names.app)['webui.url'], OLD.url);
});

test('the post-restore commands run as the platform runs them, and again without changing anything', () => {
    const env = r.restoreEnv({
        app: 'open-webui-me',
        source: { tenant: 'acme', domain: 'old.e2e.test', platformVersion: '0.5', cluster: 'zrh-1' },
        target: { tenant: 'acme', domain: 'new.e2e.test', cluster: 'gva-2' },
        volumes: [['open-webui', 'open-webui']],
    });
    const first = r.runRestore(PROFILE, names.app, env);
    assert.match(first, /webui\.url/);
    const again = r.runRestore(PROFILE, names.app, env);
    assert.match(again, /already name this domain and gateway/);
    for (const key of [OLD.key, NEW.key, MINE.key]) assert.ok(!first.includes(key) && !again.includes(key), 'a key was printed');
    r.runRestore(PROFILE, names.app, r.restoreEnv({ app: 'open-webui-me', target: { tenant: 'acme', domain: 'new.e2e.test' } }));
});

test('it names the new address and gateway, and keeps the connection an administrator added', () => {
    const s = settings(names.app);
    assert.equal(s['webui.url'], NEW.url);
    assert.deepEqual(s['openai.api_base_urls'], [NEW.gateway, MINE.url]);
    assert.deepEqual(s['openai.api_keys'], [NEW.key, MINE.key]);
});
