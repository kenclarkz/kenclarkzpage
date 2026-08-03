// Service worker registration and the two install flows.
//
// Every path here is relative on purpose: this site is served from the
// /kenclarkzpage/ subpath of github.io, so a leading slash would resolve to the
// domain root and 404.

const IOS_HINT_KEY = 'templeRunner.iosHintDismissed';

export function isInstalled() {
  return (
    window.matchMedia('(display-mode: fullscreen), (display-mode: standalone), (display-mode: minimal-ui)').matches ||
    window.navigator.standalone === true
  );
}

function isIos() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ reports itself as a Mac; the touch points give it away.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function isIosSafari() {
  if (!isIos()) return false;
  // Chrome and Firefox on iOS cannot add to the home screen at all, so there's
  // no point prompting there.
  return !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    // updateViaCache:'none' forces the browser to revalidate sw.js itself
    // instead of trusting GitHub Pages' cache headers for up to 24 hours —
    // without it, shipping a fix that nobody receives is a common outcome.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {
      /* offline play just won't be available; the game still runs */
    });
  });
}

/**
 * Wire up both install affordances.
 * @param {HTMLElement} installBtn  Android/desktop button, hidden until Chrome offers
 * @param {HTMLElement} iosHint     iOS bottom sheet
 * @param {HTMLElement} iosDismiss  its close button
 */
export function setupInstall(installBtn, iosHint, iosDismiss) {
  if (isInstalled()) return;

  let deferred = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    // Chrome only fires this once every criterion is met: HTTPS, a manifest
    // with name/short_name/start_url/display, 192 and 512 icons, and a service
    // worker with a fetch handler.
    e.preventDefault();
    deferred = e;
    installBtn.hidden = false;
  });

  installBtn.addEventListener('click', async () => {
    if (!deferred) return;
    installBtn.hidden = true;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
  });

  window.addEventListener('appinstalled', () => {
    installBtn.hidden = true;
    iosHint.hidden = true;
  });

  // iOS has no programmatic install, ever — the only route is Share > Add to
  // Home Screen, so all we can do is say so.
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(IOS_HINT_KEY) === '1';
  } catch {
    /* private browsing; just show it */
  }
  if (isIosSafari() && !dismissed) {
    iosHint.hidden = false;
    iosDismiss.addEventListener('click', () => {
      iosHint.hidden = true;
      try {
        localStorage.setItem(IOS_HINT_KEY, '1');
      } catch {
        /* ignore */
      }
    });
  }
}
