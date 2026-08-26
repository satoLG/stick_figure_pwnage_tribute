/**
 * Installing the game to a home screen.
 *
 * Two worlds, and no pretending otherwise. Chrome and the rest fire
 * `beforeinstallprompt`, which can be held onto and fired later from a real
 * press - so the offer only appears where it will actually work. iOS has no
 * such event and never will, in any browser: every engine on the phone is
 * WebKit underneath, so Chrome and Firefox there are as event-less as Safari.
 * The only route is Share > Add to Home Screen, and where that button sits
 * differs per browser - so the card names the one the player is holding.
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

class Installer {
  private deferred: InstallPromptEvent | null = null;
  /** Bumped whenever the offer appears or disappears, so a caller can re-lay. */
  version = 0;

  constructor() {
    window.addEventListener('beforeinstallprompt', (e) => {
      // Holding the event back is what lets the offer live in the game's own
      // title card instead of a browser bar over the top of it.
      e.preventDefault();
      this.deferred = e as InstallPromptEvent;
      this.version++;
    });
    window.addEventListener('appinstalled', () => {
      this.deferred = null;
      this.version++;
    });
  }

  /** Already running from a home screen: there is nothing left to offer. */
  get installed(): boolean {
    return window.matchMedia?.('(display-mode: standalone)')?.matches
      || window.matchMedia?.('(display-mode: fullscreen)')?.matches
      || (navigator as { standalone?: boolean }).standalone === true;
  }

  get isIOS(): boolean {
    const ua = navigator.userAgent;
    return /iPad|iPhone|iPod/.test(ua)
      // iPadOS reports itself as a Mac; the touch points give it away.
      || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
  }

  /**
   * Which iOS browser this is. They all run WebKit, but they hang Add to Home
   * Screen off different buttons, and a recipe that names the wrong one is
   * worse than no recipe at all.
   */
  get iosBrowser(): 'chrome' | 'firefox' | 'edge' | 'opera' | 'safari' {
    const ua = navigator.userAgent;
    if (/CriOS/.test(ua)) return 'chrome';
    if (/FxiOS/.test(ua)) return 'firefox';
    if (/EdgiOS/.test(ua)) return 'edge';
    if (/OPT|OPiOS/.test(ua)) return 'opera';
    return 'safari';
  }

  /** The three lines of the iOS recipe, worded for the browser in hand. */
  get iosSteps(): string[] {
    const share = this.iosBrowser === 'safari'
      ? 'TAP THE SHARE BUTTON IN THE BOTTOM BAR'
      : 'TAP THE SHARE BUTTON NEXT TO THE ADDRESS';
    return [
      share,
      'SCROLL DOWN TO "ADD TO HOME SCREEN"',
      'IT THEN OPENS FULL SCREEN, LIKE AN APP',
    ];
  }

  /** Only Safari could do this before iOS 16.4; the rest need the newer OS. */
  get iosNeedsSafariNote(): boolean {
    return this.iosBrowser !== 'safari';
  }

  /** A press would open the browser's own install flow. */
  get canPrompt(): boolean {
    return this.deferred !== null;
  }

  /** Something is worth showing: either the real prompt, or the iOS recipe. */
  get offer(): 'prompt' | 'ios' | null {
    if (this.installed) return null;
    if (this.deferred) return 'prompt';
    return this.isIOS ? 'ios' : null;
  }

  /** Fires the held prompt. Returns true if the browser took it from here. */
  async promptNow(): Promise<boolean> {
    const e = this.deferred;
    if (!e) return false;
    this.deferred = null;
    this.version++;
    try {
      await e.prompt();
      await e.userChoice;
      return true;
    } catch {
      return false;
    }
  }
}

export const installer = new Installer();

/** Registers the offline worker. Never in dev, where it would cache the HMR. */
export function registerWorker(): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  // Resolved against the page, not the host root: served from a project
  // subdirectory, an absolute '/sw.js' is a 404 and there is no offline play.
  const url = new URL('sw.js', document.baseURI).href;
  const scope = new URL('./', document.baseURI).href;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(url, { scope }).catch(() => {
      /* Offline play is a bonus; the game does not depend on it. */
    });
  });
}
