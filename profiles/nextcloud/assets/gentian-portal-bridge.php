<?php

declare(strict_types=1);

/**
 * Establish a Nextcloud browser session from a portal-issued bridge ticket.
 *
 * Copied into /var/www/html by the Nextcloud profile bootstrap hook. The ticket
 * is redeemed server-to-server against the portal API so embedded iframe login
 * does not depend on browser form POST + CSRF cookies (blocked as third-party).
 */

$ticket = isset($_GET['t']) ? (string) $_GET['t'] : '';
if ($ticket === '') {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Missing bridge ticket';
    exit;
}

$portalApi = getenv('GENTIAN_PORTAL_BRIDGE_API');
if (!is_string($portalApi) || $portalApi === '') {
    $portalApi = 'http://gentian-portal-gentian-portal-api.platform-kernel.svc.cluster.local:8000/api/v1';
}

$redeemUrl = rtrim($portalApi, '/') . '/session/nextcloud-bridge/redeem/' . rawurlencode($ticket);

$context = stream_context_create([
    'http' => [
        'method' => 'GET',
        'timeout' => 10,
        'ignore_errors' => true,
        'header' => "Accept: application/json\r\n",
    ],
]);

$responseBody = @file_get_contents($redeemUrl, false, $context);
if ($responseBody === false) {
    http_response_code(502);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Could not reach portal bridge';
    exit;
}

$payload = json_decode($responseBody, true);
if (!is_array($payload) || empty($payload['username']) || !is_string($payload['username'])) {
    http_response_code(401);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Invalid or expired bridge ticket';
    exit;
}

$username = $payload['username'];

require_once __DIR__ . '/lib/base.php';

$userManager = \OC::$server->getUserManager();
$userSession = \OC::$server->getUserSession();
$user = $userManager->get($username);

if ($user === null) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Nextcloud account not found';
    exit;
}

$userSession->setUser($user);

$dataDir = (string) \OC::$server->getConfig()->getSystemValue('datadirectory', \OC::$SERVERROOT . '/data');
$userDir = rtrim($dataDir, '/') . '/' . $username;
if (!is_dir($userDir . '/files')) {
    mkdir($userDir . '/files', 0770, true);
    mkdir($userDir . '/cache', 0770, true);
}
\OC::$server->getUserFolder($username);

$userSession->createSessionToken(
    \OC::$server->getRequest(),
    $user->getUID(),
    $user->getUID()
);

header('Location: /apps/files/');
exit;
