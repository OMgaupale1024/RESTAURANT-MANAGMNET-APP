/**
 * A new-ticket chime for the kitchen board, synthesised with the Web Audio API
 * — no audio file, so nothing for the CSP to block and nothing to ship.
 *
 * Browsers refuse to start audio without a user gesture. The board is a
 * touch surface (staff tap tickets), so primeSound() is called on the first
 * interaction and on the sound toggle to unlock the context.
 */
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

/** Unlocks audio on a user gesture (needed once before any sound will play). */
export function primeSound(): void {
  void audio()?.resume().catch(() => undefined);
}

/** A short rising two-tone chime — distinct enough to hear over a kitchen. */
export function chime(): void {
  const ac = audio();
  if (!ac) return;
  void ac.resume().catch(() => undefined);
  const now = ac.currentTime;

  const tone = (freq: number, start: number, dur: number) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    // Fast attack, exponential decay — a "ding", not a beep.
    gain.gain.setValueAtTime(0.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(0.3, now + start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(now + start);
    osc.stop(now + start + dur + 0.02);
  };

  tone(880, 0, 0.18); // A5
  tone(1318, 0.14, 0.24); // E6
}
