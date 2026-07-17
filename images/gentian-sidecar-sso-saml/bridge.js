const http = require('http');
const url = require('url');
const querystring = require('querystring');
const fs = require('fs');
const zlib = require('zlib');

// Extract basic generic configuration
const tenantId = process.env.SSO_TENANT_ID || 'demo';
const kernelDomain = process.env.SSO_KERNEL_DOMAIN || 'gentian.org';
const issuer = process.env.SSO_ISSUER || 'GentianSidecar';
const port = parseInt(process.env.PORT || '8081');

// Pluggable handler script
const handlerPath = process.env.APP_HANDLER_SCRIPT || '/usr/src/app/handler.js';

let appHandler = null;
if (fs.existsSync(handlerPath)) {
    appHandler = require(handlerPath);
} else {
    console.warn(`[WARNING] No app handler found at ${handlerPath}. SSO login will not inject users.`);
}

function generateAuthnRequest(host, tenantId, kernelDomain) {
    const id = "_" + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const issueInstant = new Date().toISOString();
    const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
                        xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
                        ID="${id}"
                        Version="2.0"
                        IssueInstant="${issueInstant}"
                        AssertionConsumerServiceURL="https://${host}/api/v1/authn/saml/acs"
                        Destination="https://id.${kernelDomain}/auth/realms/${tenantId}/protocol/saml">
        <saml:Issuer>${issuer}</saml:Issuer>
        <samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"
                            AllowCreate="true"/>
    </samlp:AuthnRequest>`;

    const deflated = zlib.deflateRawSync(Buffer.from(xml, 'utf8'));
    return encodeURIComponent(deflated.toString('base64'));
}

function getAttributeValue(xml, name) {
    const regex = new RegExp(`Name="${name}"[^]*?<[^:]*?:?AttributeValue[^]*?>([^<]+)</[^:]*?:?AttributeValue>`);
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
}

async function startServer() {
    console.log(`SSO SAML Sidecar started: tenantId=${tenantId}, kernelDomain=${kernelDomain}, issuer=${issuer}`);
    
    const server = http.createServer(async (req, res) => {
        const parsedUrl = url.parse(req.url, true);
        
        if (parsedUrl.pathname === '/sso/login') {
            const host = req.headers.host || req.headers['x-forwarded-host'];
            const samlRedirect = generateAuthnRequest(host, tenantId, kernelDomain);
            const redirectUrl = `https://id.${kernelDomain}/auth/realms/${tenantId}/protocol/saml?SAMLRequest=${samlRedirect}`;
            
            res.writeHead(302, { 'Location': redirectUrl });
            res.end();
            
        } else if (parsedUrl.pathname === '/sso/acs' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const postParams = querystring.parse(body);
                    const samlResponse = postParams.SAMLResponse;
                    if (!samlResponse) {
                        res.writeHead(400, { 'Content-Type': 'text/plain' });
                        res.end('Missing SAMLResponse');
                        return;
                    }
                    
                    const decodedXml = Buffer.from(samlResponse, 'base64').toString('utf8');
                    const email = getAttributeValue(decodedXml, 'email');
                    const firstName = getAttributeValue(decodedXml, 'firstName');
                    const lastName = getAttributeValue(decodedXml, 'lastName');
                    
                    if (!email) {
                        res.writeHead(400, { 'Content-Type': 'text/plain' });
                        res.end('Email attribute not found in SAML assertion');
                        return;
                    }
                    
                    const profile = { email, firstName, lastName };
                    
                    if (appHandler && typeof appHandler.onLogin === 'function') {
                        // Delegate to app handler
                        await appHandler.onLogin(profile, req, res);
                    } else {
                        // Default fallback
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ message: "SAML login successful but no handler is configured.", profile }));
                    }
                } catch (err) {
                    console.error('ACS callback error:', err);
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Internal Server Error: ' + err.message);
                }
            });
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    });
    
    server.listen(port, '0.0.0.0', () => {
        console.log(`SSO SAML Sidecar listening on 0.0.0.0:${port}`);
    });
}

startServer().catch(err => {
    console.error('SSO Sidecar startup failed:', err);
});
