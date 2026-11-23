let sharedCtx: AudioContext | null = null;

// Warm pentatonic frequencies (C4 major pentatonic across 2 octaves)
const PENTATONIC_HZ = [
  261.63, 293.66, 329.63, 392.0, 440.0,
  523.25, 587.33, 659.25, 783.99, 880.0,
];

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!sharedCtx) {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioCtx) {
      sharedCtx = new AudioCtx();
    }
  }
  if (sharedCtx && sharedCtx.state === 'suspended') {
    sharedCtx.resume().catch(() => {});
  }
  return sharedCtx;
}

export function playLetterChime(letterIndex: number): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const freq = PENTATONIC_HZ[letterIndex % PENTATONIC_HZ.length];

  const osc = ctx.createOscillator();
  const subOsc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, now);

  subOsc.type = 'triangle';
  subOsc.frequency.setValueAtTime(freq * 2, now);

  const subGain = ctx.createGain();
  subGain.gain.setValueAtTime(0.08, now);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.12, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);

  osc.connect(gain);
  subOsc.connect(subGain);
  subGain.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  subOsc.start(now);
  osc.stop(now + 0.6);
  subOsc.stop(now + 0.6);
}
