import { useCallback, useEffect, useRef, useState } from 'react';
import { inputManager, touchSource, TOUCH_SOURCE_PREFIX } from '../lib/inputManager';
import { GAME_KEYS } from '../lib/keyMap';

/**
 * Zones are laid out as eight columns in the top row (A S D F J K L ;) plus the
 * wide space bar zone underneath. The order intentionally differs from
 * `playerState`'s index order because the space key is drawn separately.
 */
const ZONE_CODES: readonly string[] = [
  ...GAME_KEYS.filter((gameKey) => gameKey.code !== 'Space').map((gameKey) => gameKey.code),
  'Space',
];

const ZONE_COUNT = ZONE_CODES.length;

function getZoneIndexFromPoint(
  zones: readonly (HTMLDivElement | null)[],
  x: number,
  y: number,
): number {
  for (let i = 0; i < zones.length; i += 1) {
    const zoneNode = zones[i];
    if (!zoneNode) continue;
    const rect = zoneNode.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return i;
    }
  }
  return -1;
}

/**
 * Full-screen touch layer that turns finger positions into the same
 * press/release notifications the physical keyboard produces.
 *
 * Each finger is its own input source (`touch:<identifier>`), so multiple
 * fingers can hold keys independently and a key held by both a finger and the
 * keyboard stays down until every holder lets go.
 */
function TouchOverlay() {
  const [pressedZones, setPressedZones] = useState<boolean[]>(() =>
    Array.from({ length: ZONE_COUNT }, () => false),
  );
  const zoneRefs = useRef<(HTMLDivElement | null)[]>([]);
  const touchToZoneMap = useRef<Map<number, number>>(new Map());
  const overlayRef = useRef<HTMLDivElement>(null);

  const resolveZone = useCallback((x: number, y: number) => {
    return getZoneIndexFromPoint(zoneRefs.current, x, y);
  }, []);

  // Visual highlight is derived from the shared pressed state, so it also
  // reflects keys held on the physical keyboard.
  useEffect(() => {
    const syncPressedZones = () => {
      const next = ZONE_CODES.map((code) => inputManager.isPressed(code));
      setPressedZones((previous) =>
        previous.length === next.length && previous.every((value, index) => value === next[index])
          ? previous
          : next,
      );
    };

    syncPressedZones();
    return inputManager.subscribe(syncPressedZones);
  }, []);

  useEffect(() => {
    const overlayNode = overlayRef.current;
    if (!overlayNode) return;

    const pressZone = (identifier: number, zoneIndex: number) => {
      touchToZoneMap.current.set(identifier, zoneIndex);
      inputManager.press(ZONE_CODES[zoneIndex], touchSource(identifier));
    };

    const releaseTouch = (identifier: number) => {
      const zoneIndex = touchToZoneMap.current.get(identifier);
      if (zoneIndex === undefined) return;
      touchToZoneMap.current.delete(identifier);
      inputManager.release(ZONE_CODES[zoneIndex], touchSource(identifier));
    };

    const handleTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      for (const touch of Array.from(e.changedTouches)) {
        if (touchToZoneMap.current.has(touch.identifier)) {
          // Duplicate start: make sure the source is registered for its zone.
          const zoneIndex = touchToZoneMap.current.get(touch.identifier)!;
          inputManager.press(ZONE_CODES[zoneIndex], touchSource(touch.identifier));
          continue;
        }
        const zoneIndex = resolveZone(touch.clientX, touch.clientY);
        if (zoneIndex !== -1) {
          pressZone(touch.identifier, zoneIndex);
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      for (const touch of Array.from(e.changedTouches)) {
        const oldZoneIndex = touchToZoneMap.current.get(touch.identifier);
        const newZoneIndex = resolveZone(touch.clientX, touch.clientY);

        if (oldZoneIndex === newZoneIndex) continue;

        // Release the old key first, then press the new one. Moving past every
        // zone simply releases and leaves the finger idle.
        if (oldZoneIndex !== undefined) {
          releaseTouch(touch.identifier);
        }
        if (newZoneIndex !== -1) {
          pressZone(touch.identifier, newZoneIndex);
        }
      }
    };

    const handleTouchEndOrCancel = (e: TouchEvent) => {
      e.preventDefault();
      for (const touch of Array.from(e.changedTouches)) {
        releaseTouch(touch.identifier);
      }
    };

    overlayNode.addEventListener('touchstart', handleTouchStart as EventListener, { passive: false });
    overlayNode.addEventListener('touchmove', handleTouchMove as EventListener, { passive: false });
    overlayNode.addEventListener('touchend', handleTouchEndOrCancel as EventListener, { passive: false });
    overlayNode.addEventListener('touchcancel', handleTouchEndOrCancel as EventListener, { passive: false });

    const activeTouches = touchToZoneMap.current;
    return () => {
      overlayNode.removeEventListener('touchstart', handleTouchStart as EventListener);
      overlayNode.removeEventListener('touchmove', handleTouchMove as EventListener);
      overlayNode.removeEventListener('touchend', handleTouchEndOrCancel as EventListener);
      overlayNode.removeEventListener('touchcancel', handleTouchEndOrCancel as EventListener);

      // Fingers may still be down when the overlay disappears (level finished,
      // back to menu, ...). Release them so nothing stays pressed.
      activeTouches.clear();
      inputManager.releaseSourcePrefix(TOUCH_SOURCE_PREFIX);
    };
  }, [resolveZone]);

  return (
    <div
      ref={overlayRef}
      data-touch-overlay=""
      className="absolute inset-0 z-10 flex flex-col"
      style={{ touchAction: 'none' }}
    >
      <div className="grow flex">
        {ZONE_CODES.slice(0, ZONE_COUNT - 1).map((code, i) => (
          <div
            key={code}
            ref={el => { zoneRefs.current[i] = el; }}
            data-touch-zone={code}
            className={`flex-1 h-full border-r border-white/10 ${
              pressedZones[i] ? 'bg-white/30' : 'bg-transparent'
            } transition-colors duration-200`}
          />
        ))}
      </div>
      <div
        ref={el => { zoneRefs.current[ZONE_COUNT - 1] = el; }}
        data-touch-zone={ZONE_CODES[ZONE_COUNT - 1]}
        className={`h-1/5 border-t border-white/10 ${
          pressedZones[ZONE_COUNT - 1] ? 'bg-white/30' : 'bg-transparent'
        } transition-colors duration-200`}
      />
    </div>
  );
}

export default TouchOverlay;
