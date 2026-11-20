// SPDX-License-Identifier: MIT
//
// The page that frames a Crafting App and stands between it and the person's
// files. The app speaks its host messages (<app>:ready, :open, :save, :dirty)
// to the page of its own address; this page answers them with the four file
// calls of this address (/files/list, /files/content). It holds no token.
'use strict';

(async function () {
  const $ = (id) => document.getElementById(id);
  const frame = $('app');
  const openButton = $('open');
  const where = $('where');
  const status = $('status');
  const actions = $('actions');
  const browser = $('browser');

  const config = await (await fetch('/host/config')).json();
  const kind = (name) => config.app + ':' + name;
  document.title = config.title;
  frame.title = config.title;

  // Documents this page put in the app or wrote for it, by file name: where
  // each is among the person's files and the mark of the version last seen.
  const known = new Map();
  let dirty = false;
  // A save that did not reach the files. Kept so that nothing is lost: the
  // app counts a document as saved once it has handed it over.
  let pending = null;
  let lastFolder = '/';

  // ── The file calls ──────────────────────────────────────────────────────

  async function call(method, path, options = {}) {
    const response = await fetch(path, {
      method,
      headers: { 'X-Craft-Host': '1', ...(options.headers || {}) },
      body: options.body,
    });
    if (!response.ok) {
      let message = 'The files did not answer (' + response.status + ').';
      try { message = (await response.json()).error || message; } catch (_) { /* not JSON */ }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return response;
  }

  const listFolder = async (path) =>
    (await call('GET', '/files/list?path=' + encodeURIComponent(path))).json();

  async function readFile(path) {
    const response = await call('GET', '/files/content?path=' + encodeURIComponent(path));
    return { bytes: await response.arrayBuffer(), etag: response.headers.get('ETag') || '' };
  }

  // condition: {ifMatch} replaces only the version read, {ifNoneMatch: '*'}
  // writes only where nothing is, {} writes whatever is there.
  async function writeFile(path, bytes, condition) {
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (condition.ifMatch) headers['If-Match'] = condition.ifMatch;
    if (condition.ifNoneMatch) headers['If-None-Match'] = condition.ifNoneMatch;
    const response = await call('PUT', '/files/content?path=' + encodeURIComponent(path), { headers, body: bytes });
    return (await response.json()).etag || '';
  }

  // ── What the person is shown ────────────────────────────────────────────

  function say(text, failed) {
    status.textContent = text;
    status.classList.toggle('failed', Boolean(failed));
  }

  function offer(buttons) {
    actions.replaceChildren(...buttons.map(([label, run, primary]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (primary) b.className = 'primary';
      b.addEventListener('click', run);
      return b;
    }));
  }

  const join = (folder, name) => (folder === '/' ? '' : folder) + '/' + name;
  const folderOf = (path) => path.slice(0, path.lastIndexOf('/')) || '/';
  const extensionOf = (name) => (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();

  function size(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  // ── The folder dialog, for opening and for choosing where to save ───────

  // Resolves with {path} for a file picked (open) or a place and name chosen
  // (save), or null when the person cancels.
  function browse(mode, suggestedName) {
    return new Promise((resolve) => {
      const saving = mode === 'save';
      $('browser-title').textContent = saving ? 'Save to your files' : 'Open from your files';
      $('name-row').hidden = !saving;
      $('confirm').hidden = !saving;
      $('name').value = suggestedName || '';
      let folder = lastFolder;

      const finish = (result) => {
        $('cancel').removeEventListener('click', cancel);
        $('confirm').removeEventListener('click', confirm);
        browser.removeEventListener('cancel', cancel);
        browser.close();
        resolve(result);
      };
      const cancel = () => finish(null);
      const confirm = () => {
        const name = $('name').value.trim();
        if (!name || name.includes('/') || name.includes('\\')) {
          $('browser-note').textContent = 'Give the file a name.';
          return;
        }
        lastFolder = folder;
        finish({ path: join(folder, name) });
      };

      async function show(path) {
        $('browser-note').textContent = 'Loading…';
        let listing;
        try {
          listing = await listFolder(path);
        } catch (error) {
          if (path !== '/') return show('/');
          $('entries').replaceChildren();
          $('browser-note').textContent = error.message;
          return;
        }
        folder = listing.path;

        const crumbs = [['Files', '/']];
        let walked = '';
        for (const part of folder.split('/').filter(Boolean)) {
          walked += '/' + part;
          crumbs.push([part, walked]);
        }
        $('crumbs').replaceChildren(...crumbs.flatMap(([label, target], i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = label;
          b.addEventListener('click', () => show(target));
          return i ? [document.createTextNode('›'), b] : [b];
        }));

        $('entries').replaceChildren(...listing.entries.map((e) => {
          const li = document.createElement('li');
          const b = document.createElement('button');
          b.type = 'button';
          const name = document.createElement('span');
          name.textContent = e.folder ? e.name + ' /' : e.name;
          b.append(name);
          if (e.folder) {
            b.className = 'folder';
            b.addEventListener('click', () => show(join(folder, e.name)));
          } else {
            const s = document.createElement('span');
            s.className = 'size';
            s.textContent = size(e.size);
            b.append(s);
            b.addEventListener('click', () => {
              if (saving) {
                $('name').value = e.name;
              } else {
                lastFolder = folder;
                finish({ path: join(folder, e.name) });
              }
            });
          }
          li.append(b);
          return li;
        }));
        $('browser-note').textContent = listing.entries.length ? '' : 'Nothing here that ' + config.title + ' opens.';
      }

      $('cancel').addEventListener('click', cancel);
      $('confirm').addEventListener('click', confirm);
      browser.addEventListener('cancel', cancel);
      browser.showModal();
      show(folder);
    });
  }

  // ── Open ────────────────────────────────────────────────────────────────

  async function open() {
    const picked = await browse('open');
    if (!picked) return;
    const name = picked.path.slice(picked.path.lastIndexOf('/') + 1);
    say('Opening ' + name + '…');
    try {
      const file = await readFile(picked.path);
      known.set(name, { path: picked.path, etag: file.etag });
      frame.contentWindow.postMessage(
        { type: kind('open'), name, bytes: file.bytes }, location.origin, [file.bytes]);
      where.textContent = picked.path;
      say('');
    } catch (error) {
      say(error.message, true);
    }
  }

  // ── Save ────────────────────────────────────────────────────────────────

  function download(save) {
    const url = URL.createObjectURL(new Blob([save.bytes]));
    const a = document.createElement('a');
    a.href = url;
    a.download = save.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function failed(save, error) {
    pending = save;
    say(save.name + ' was not saved: ' + error.message, true);
    const retry = ['Try again', () => store(save, save.target, save.condition), true];
    const elsewhere = ['Save somewhere else…', () => place(save)];
    const local = ['Download', () => { download(save); settled('Downloaded ' + save.name); }];
    if (error.status === 412) {
      // Changed elsewhere since it was opened, or a file of that name is
      // there already: replacing it is the person's to say.
      offer([['Replace it', () => store(save, save.target, {}), true], elsewhere, local]);
    } else {
      offer([retry, elsewhere, local]);
    }
  }

  function settled(text) {
    pending = null;
    offer([]);
    say(text);
  }

  // Writes a save to a path. A document format becomes the place the next
  // Save of that name goes to; an export (PDF, PNG) is a copy and does not.
  async function store(save, target, condition) {
    save.target = target;
    save.condition = condition;
    offer([]);
    say('Saving ' + save.name + '…');
    try {
      const etag = await writeFile(target, save.bytes, condition);
      const name = target.slice(target.lastIndexOf('/') + 1);
      if (config.extensions.includes(extensionOf(name))) {
        known.set(save.name, { path: target, etag });
        known.set(name, { path: target, etag });
        where.textContent = target;
      }
      settled('Saved ' + target + ' at ' + new Date().toLocaleTimeString());
    } catch (error) {
      failed(save, error);
    }
  }

  // Asks where a save goes that has no place yet.
  async function place(save) {
    const chosen = await browse('save', save.name);
    if (!chosen) {
      if (!pending) pending = save;
      say(save.name + ' is not saved yet.', true);
      offer([['Choose a place…', () => place(save), true], ['Download', () => { download(save); settled('Downloaded ' + save.name); }]]);
      return;
    }
    await store(save, chosen.path, { ifNoneMatch: '*' });
  }

  function onSave(message) {
    if (!(message.bytes instanceof ArrayBuffer) || typeof message.name !== 'string') return;
    const save = { name: message.name, bytes: message.bytes };
    const at = known.get(save.name);
    if (at && !message.saveAs) {
      store(save, at.path, at.etag ? { ifMatch: at.etag } : {});
    } else {
      place(save);
    }
  }

  // ── The app's messages ──────────────────────────────────────────────────

  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case kind('ready'):
        openButton.disabled = false;
        say('');
        break;
      case kind('failed'):
        say(config.title + ' could not start: ' + String(message.error || ''), true);
        break;
      case kind('dirty'):
        dirty = Boolean(message.dirty);
        break;
      case kind('save'):
        onSave(message);
        break;
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (dirty || pending) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  openButton.addEventListener('click', open);
  say('Starting ' + config.title + '…');
  const author = config.person ? '&author=' + encodeURIComponent(config.person) : '';
  frame.src = '/app/?host=parent' + author;
})();
