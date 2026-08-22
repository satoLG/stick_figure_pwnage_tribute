/**
 * Installing the game to a home screen.
 *
 * Two worlds, and no pretending otherwise. Chrome and the rest fire
 * `beforeinstallprompt`, which can be held onto and fired later from a real
 * press - so the offer only appears where it will actually work. iOS has no
 * such event and never will: there, the only route is Share > Add to Home
 * Screen, so the button opens a card that says exactly that.
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
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* Offline play is a bonus; the game does not depend on it. */
    });
  });
}
