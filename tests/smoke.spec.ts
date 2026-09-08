import { test, expect, type ConsoleMessage } from '@playwright/test';

// Hash a Uint8ClampedArray of RGBA pixels into a short, comparable string.
// 32-bit FNV-1a — fast, no deps, and good enough to detect "canvas redrew".
function hashPixels(pixels: Uint8ClampedArray): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < pixels.length; i++) {
    hash ^= pixels[i] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

test('picture redraws and V toggle does not crash', async ({ page }) => {
  // Collect console errors across the whole run; Playwright's page.on is the
  // cleanest way to assert "no console errors" — console.error is the only
  // channel we treat as a failure.
  const consoleErrors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(`pageerror: ${err.message}`);
  });

  await page.goto('/', { waitUntil: 'load' });

  // Canvas must exist and have a non-zero rendered size.
  const canvas = page.locator('#game');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box, 'canvas bounding box').not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);

  // Read pixels straight off the canvas. Canvas2D defaults to
  // preserveDrawingBuffer=true in practice for getImageData when the context
  // was created with alpha:false — but to be safe we force a paint-and-read
  // inside the page via a requestAnimationFrame.
  async function snapshotHash(): Promise<string> {
    return page.evaluate(() => {
      const c = document.getElementById('game') as HTMLCanvasElement | null;
      if (!c) throw new Error('no canvas');
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('no 2d context');
      // sample the inner 80% so we skip any letterbox bars
      const sx = Math.floor(c.width * 0.1);
      const sy = Math.floor(c.height * 0.1);
      const sw = Math.floor(c.width * 0.8);
      const sh = Math.floor(c.height * 0.8);
      const data = ctx.getImageData(sx, sy, sw, sh).data;
      // copy into a plain Uint8Array so the page can hand it back cleanly
      return Array.from(data);
    }).then((arr) => hashPixels(new Uint8ClampedArray(arr)));
  }

  // Let the loop tick at least one frame so the first hash isn't all-zero.
  await page.waitForTimeout(250);
  const hashBefore = await snapshotHash();

  // Move the figure: arrow keys + one shot. The exact inputs don't matter
  // for the picture/world split — we just need the canvas to repaint.
  await canvas.focus().catch(() => undefined);
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(200);
  await page.keyboard.up('ArrowRight');
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);

  const hashAfter = await snapshotHash();
  expect(hashAfter, 'canvas pixels changed after input').not.toBe(hashBefore);

  // Toggle 15/60 fps with V. The picture keeps drawing either way; the
  // important assertion is that the page is still alive.
  await page.keyboard.press('v');
  await page.waitForTimeout(200);
  await page.keyboard.press('v');
  await page.waitForTimeout(200);

  // Canvas should still be visible and the page should not have crashed.
  await expect(canvas).toBeVisible();
  const stillAlive = await page.evaluate(() => document.readyState === 'complete' && !!document.getElementById('game'));
  expect(stillAlive).toBe(true);

  expect(consoleErrors, 'no console errors during smoke').toEqual([]);
});