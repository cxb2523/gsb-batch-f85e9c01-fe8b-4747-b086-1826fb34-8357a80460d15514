import { expect, test } from '@playwright/test';

test('borrowed live frames go stale on pose change and refuse every read and write path', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const result = await page.evaluate(() => window.rigPlayHarness.liveFrameLeaseProbe());
  expect(result.normalReads).toBe(true);
  expect(result.generationMonotonic).toBe(true);
  expect(result.freshReads).toBe(true);
  expect(result.clipPresent).toBe(true);
  // Every held view — frame, nested buffer, attachment, tint, clip and polygon — goes stale.
  expect(result.stale).toBe(true);
  expect(result.staleNested).toBe(true);
  expect(result.staleAttachment).toBe(true);
  expect(result.staleTint).toBe(true);
  expect(result.staleClip).toBe(true);
  expect(result.stalePolygon).toBe(true);
  expect(result.rendererStale).toBe(true);
  // Writes and backing-store escapes are read-only on a live lease.
  expect(result.readonlyWrite).toBe(true);
  expect(result.readonlyBuffer).toBe(true);
  expect(result.readonlyNestedWrite).toBe(true);
  expect(result.readonlyPolygonWrite).toBe(true);
  // Snapshots are fully detached from later poses.
  expect(result.snapshotKept).toBe(true);
  expect(result.noSharedVertices).toBe(true);
  expect(result.noSharedClips).toBe(true);
  expect(result.noSharedClipPolygons).toBe(true);
  expect(result.internalClipSharing).toBe(true);
  expect(result.snapshotRows).toBeGreaterThan(0);
});

test('runtime to oracle fallback invalidates the old lease and poser names the source reason', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const result = await page.evaluate(() => window.rigPlayHarness.liveFrameFallbackProbe());
  expect(result.runtimePoser).toBe('runtime');
  expect(result.composedReason).toBe(true);
  expect(result.composedPoser).toMatch(/^oracle: track composition/);
  expect(result.oldStale).toBe(true);
  expect(result.nestedStale).toBe(true);
  expect(result.freshUsable).toBe(true);
  expect(result.rendererFresh).toBe(true);
  expect(result.timeKept).toBe(true);
  // The physics policy is an oracle path from the start, named by constraint.
  expect(result.physicsReason).toBe(true);
  expect(result.physicsPoser).toMatch(/^oracle: physics constraint ".+" requires player clock, seek and movement integration$/);
  expect(result.physicsLeaseUsable).toBe(true);
});

test('dispose refuses new borrows and every read of a held lease', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const result = await page.evaluate(() => window.rigPlayHarness.liveFrameDisposeProbe());
  expect(result.clipPresent).toBe(true);
  expect(result.borrowAfterDispose).toBe(true);
  expect(result.oldReadAfterDispose).toBe(true);
  expect(result.nestedAfterDispose).toBe(true);
  expect(result.clipAfterDispose).toBe(true);
  expect(result.rendererAfterDispose).toBe(true);
  expect(result.doubleDisposeSafe).toBe(true);
});

test('production borrows reuse buffers across generations while snapshots stay detached', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigPlayHarness));
  const result = await page.evaluate(() => window.rigPlayHarness.liveFrameProductionProbe());
  expect(result.reused).toBe(true);
  expect(result.advanced).toBe(true);
  expect(result.snapshotDetached).toBe(true);
});
