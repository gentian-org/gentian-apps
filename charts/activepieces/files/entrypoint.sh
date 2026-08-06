#!/bin/sh
# Gentian entrypoint for the Activepieces container.
#
# Owns process startup so that the profile does not have to: the AppProfile passes
# values, never a command. See profiles/activepieces/customizations/ for the
# Customization records covering the two startup patches below.
#
# Note: the blocks below are deliberately left unindented — they carry heredocs
# whose terminators must sit at column 0.
set -u

NGINX_CONF_SRC="${GENTIAN_NGINX_CONF:-/etc/activepieces/nginx.conf}"
NGINX_CONF=/tmp/nginx.conf

# ---------------------------------------------------------------------------
# 1. Session restore — sync the ap_token cookie into localStorage and send
#    sign-in/sign-up at the SAML gateway.
#
#    L5. The cookie outlives localStorage (new tab, browser restart), so the
#    shipped index.html needs the shim. Replace with an nginx sub_filter that
#    injects the same <script> into <head> on the fly once ngx_http_sub_module
#    is confirmed present in the image; then this block and its rung go away.
# ---------------------------------------------------------------------------
if [ "${GENTIAN_INJECT_SESSION_SCRIPT:-true}" = "true" ]; then
node -e "
const fs = require('fs');
const root = '/usr/share/nginx/html';
const files = ['/usr/share/nginx/html/index.html'];
try {
    fs.readdirSync(root).forEach(dir => {
        files.push(root + '/' + dir + '/index.html');
    });
} catch (e) {}

files.forEach(file => {
    if (fs.existsSync(file) && !fs.lstatSync(file).isDirectory()) {
        let html = fs.readFileSync(file, 'utf8');
        if (!html.includes('ap_token')) {
            const script = '<script>(function(){const loginUrl=\'/api/v1/authn/saml/login\';if(!localStorage.getItem(\'token\')){const mT=document.cookie.match(/ap_token=([^;]+)/);const mU=document.cookie.match(/ap_user=([^;]+)/);if(mT&&mU){localStorage.setItem(\'token\',mT[1]);localStorage.setItem(\'currentUser\',decodeURIComponent(mU[1]));window.location.reload();}else{window.location.href=loginUrl;}}const intercept=function(url){if(url&&(url.includes(\'sign-in\')||url.includes(\'sign-up\'))){if(!localStorage.getItem(\'token\')){window.location.href=loginUrl;return true;}}return false;};const originalPush=window.history.pushState;window.history.pushState=function(state,title,url){if(intercept(url))return;return originalPush.apply(this,arguments);};const originalReplace=window.history.replaceState;window.history.replaceState=function(state,title,url){if(intercept(url))return;return originalReplace.apply(this,arguments);};})();</script>';
            html = html.replace('<head>', '<head>' + script);
            fs.writeFileSync(file, html, 'utf8');
            console.log('Injected token sync and history interceptor script into ' + file);
        }
    }
});
"
fi

# ---------------------------------------------------------------------------
# 2. Upgrade banner — main.js asks raw.githubusercontent.com for the latest
#    release and renders a banner when it is newer than the running version.
#
#    L5, and the weakest link here: a literal string replace against a minified
#    bundle, silently a no-op after any upstream rebuild. The same effect is
#    available at L0 — the fetch is wrapped in try/catch returning "0.0.0", so
#    denying egress to raw.githubusercontent.com in spec.security.egress
#    suppresses the banner with no patching. Delete this once that lands.
# ---------------------------------------------------------------------------
if [ "${GENTIAN_DISABLE_UPGRADE_BANNER:-true}" = "true" ]; then
cat << 'EOF' > /tmp/patch_banner.py
import os
file = "/usr/src/app/dist/packages/server/api/main.js"
if os.path.exists(file):
    with open(file, "r") as f:
        c = f.read()
    old = 'try{return(yield n.default.get("https://raw.githubusercontent.com/activepieces/activepieces/main/package.json")).data.version}catch(e){return"0.0.0"}'
    new = 'try{return yield this.getCurrentRelease()}catch(e){return"0.0.0"}'
    if old in c:
        c = c.replace(old, new)
        with open(file, "w") as f:
            f.write(c)
        print("Patched main.js successfully to disable upgrade banner")
EOF
python3 /tmp/patch_banner.py
fi

# ---------------------------------------------------------------------------
# 3. Resolve the SAML gateway and start nginx with the Gentian config.
#
#    Prefer an explicit host from values (gentian.sso.host). The fallback reads
#    the Docker-link-style service env var, which Kubernetes only injects when
#    the Service already existed at pod creation — an ordering trap on cold
#    start. Setting gentian.sso.host in the profile avoids it entirely.
# ---------------------------------------------------------------------------
cp "$NGINX_CONF_SRC" "$NGINX_CONF"

SSO_IP="${GENTIAN_SSO_HOST:-}"
if [ -z "$SSO_IP" ]; then
    SSO_IP=$(env | grep "_SSO_SAML_SERVICE_HOST=" | cut -d= -f2 | head -n 1)
fi
if [ -z "$SSO_IP" ]; then
    echo "FATAL: no SAML gateway host. Set gentian.sso.host, or ensure the" >&2
    echo "       sso-saml Service exists before this pod starts." >&2
    exit 1
fi
sed -i "s/SSO_IP_PLACEHOLDER/${SSO_IP}/g" "$NGINX_CONF"

nginx -c "$NGINX_CONF" -g "daemon off;" &

# 4. Backend server (exec so signals reach it).
exec node --enable-source-maps /usr/src/app/dist/packages/server/api/main.js
