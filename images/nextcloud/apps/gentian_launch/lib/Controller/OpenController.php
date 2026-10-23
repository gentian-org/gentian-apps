<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace OCA\GentianLaunch\Controller;

use OCP\App\IAppManager;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\RedirectResponse;
use OCP\Files\File;
use OCP\Files\IRootFolder;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IURLGenerator;
use OCP\IUserSession;
use Psr\Log\LoggerInterface;

/**
 * Where the Document, Spreadsheet and Presentation tiles land.
 *
 * The person's most recently changed file of that kind opens in Nextcloud
 * Office; somebody who has none gets a new one, made from Office's own empty
 * template in their home folder. Their templates folder is not looked in:
 * Nextcloud fills it with samples at sign-up (Invoice.ods, Elegant.odp, ...),
 * and those are not documents of theirs to reopen. This is what the v0.4 portal bridge did with
 * ?open=<kind>, without the bridge: the person is already signed in to
 * Nextcloud, and one who is not is sent through Nextcloud's own sign-in first.
 *
 * Without Nextcloud Office enabled there is nothing to open a document in, so
 * the tile lands in Files.
 *
 * A GET that may create a file, and so no CSRF token: a tile is a link. The
 * most it can do for somebody else's link is give the person an empty
 * document they did not ask for.
 */
class OpenController extends Controller {
    private const KINDS = [
        'document' => [
            'template' => 'template.odt',
            'name' => 'New Document.odt',
            'mimes' => [
                'application/vnd.oasis.opendocument.text',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            ],
        ],
        'spreadsheet' => [
            'template' => 'template.ods',
            'name' => 'New Spreadsheet.ods',
            'mimes' => [
                'application/vnd.oasis.opendocument.spreadsheet',
                'application/vnd.ms-excel',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ],
        ],
        'presentation' => [
            'template' => 'template.odp',
            'name' => 'New Presentation.odp',
            'mimes' => [
                'application/vnd.oasis.opendocument.presentation',
                'application/vnd.ms-powerpoint',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            ],
        ],
    ];

    public function __construct(
        string $appName,
        IRequest $request,
        private IRootFolder $root,
        private IUserSession $session,
        private IAppManager $apps,
        private IURLGenerator $urls,
        private IConfig $config,
        private LoggerInterface $logger,
    ) {
        parent::__construct($appName, $request);
    }

    #[NoAdminRequired]
    #[NoCSRFRequired]
    public function open(string $kind): RedirectResponse {
        $files = new RedirectResponse($this->urls->linkToRoute('files.view.index'));
        $spec = self::KINDS[$kind] ?? null;
        $user = $this->session->getUser();
        if ($spec === null || $user === null || !$this->apps->isEnabledForUser('richdocuments', $user)) {
            return $files;
        }
        try {
            $folder = $this->root->getUserFolder($user->getUID());
            $templates = trim($this->config->getUserValue($user->getUID(), 'core', 'templateDirectory', ''), '/');
            $newest = null;
            foreach ($spec['mimes'] as $mime) {
                foreach ($folder->searchByMime($mime) as $node) {
                    if (!$node instanceof File) {
                        continue;
                    }
                    $relative = trim((string)$folder->getRelativePath($node->getPath()), '/');
                    if ($templates !== '' && str_starts_with($relative, $templates . '/')) {
                        continue;
                    }
                    if ($newest === null || $node->getMTime() > $newest->getMTime()) {
                        $newest = $node;
                    }
                }
            }
            if ($newest === null) {
                $template = $this->apps->getAppPath('richdocuments') . '/emptyTemplates/' . $spec['template'];
                $content = file_get_contents($template);
                if ($content === false) {
                    $this->logger->warning('Office template {template} could not be read', ['template' => $template]);
                    return $files;
                }
                $newest = $folder->newFile($folder->getNonExistingName($spec['name']), $content);
            }
            return new RedirectResponse($this->urls->linkToRoute('files.view.showFile', ['fileid' => $newest->getId()]));
        } catch (\Throwable $e) {
            $this->logger->warning('Could not open a {kind} for {user}', ['kind' => $kind, 'user' => $user->getUID(), 'exception' => $e]);
            return $files;
        }
    }
}
