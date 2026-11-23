import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AlphabetLetter } from '../data/alphabet';

interface LetterCanvasProps {
  item: AlphabetLetter;
  cycleProgress: number; // 0 to 1 over the 2s interval
  intervalMs: number;
  drawKey: number;
}

interface NibPosition {
  x: number;
  y: number;
  visible: boolean;
}

export function LetterCanvas({
  item,
  cycleProgress,
  intervalMs,
  drawKey,
}: LetterCanvasProps) {
  const pathRefs = useRef<(SVGPathElement | null)[]>([]);
  const lengthsRef = useRef<number[]>([]);
  const [drawProgress, setDrawProgress] = useState(0);
  const [nib, setNib] = useState<NibPosition>({ x: 120, y: 120, visible: false });
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Measure path lengths synchronously before paint when letter changes
  useLayoutEffect(() => {
    const measured = item.strokes.map((_, idx) => {
      const el = pathRefs.current[idx];
      if (!el) return 100;
      const len = el.getTotalLength();
      return len > 0 ? len : 1;
    });
    lengthsRef.current = measured;
  }, [item, drawKey]);

  // Animate stroke drawing smoothly from 0 -> 1 on every letter/drawKey trigger
  useEffect(() => {
    if (prefersReducedMotion) {
      setDrawProgress(1);
      setNib({ x: 120, y: 120, visible: false });
      return;
    }

    setDrawProgress(0);
    setNib({ x: 120, y: 120, visible: false });

    const drawDuration = Math.min(1250, Math.max(550, intervalMs * 0.62));
    let startTime: number | null = null;
    let rafId = 0;

    const tick = (now: number) => {
      if (startTime === null) startTime = now;
      const elapsed = now - startTime;
      const raw = Math.min(1, elapsed / drawDuration);
      // Smooth ease-in-out cubic for calligraphic stroke flow
      const eased =
        raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;

      setDrawProgress(eased);

      // Update glowing nib position along the currently active stroke
      const lengths = lengthsRef.current;
      const totalLength = lengths.reduce((sum, l) => sum + l, 0);

      if (raw < 0.995 && totalLength > 0) {
        const targetDist = eased * totalLength;
        let acc = 0;
        let found = false;

        for (let i = 0; i < lengths.length; i++) {
          const segLen = lengths[i];
          if (targetDist <= acc + segLen || i === lengths.length - 1) {
            const localDist = Math.max(0, Math.min(segLen, targetDist - acc));
            const el = pathRefs.current[i];
            if (el) {
              const pt = el.getPointAtLength(localDist);
              setNib({ x: pt.x, y: pt.y, visible: true });
              found = true;
            }
            break;
          }
          acc += segLen;
        }
        if (!found) {
          setNib((prev) => ({ ...prev, visible: false }));
        }
      } else {
        setNib((prev) => ({ ...prev, visible: false }));
      }

      if (raw < 1) {
        rafId = requestAnimationFrame(tick);
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [item, intervalMs, drawKey, prefersReducedMotion]);

  // Compute individual stroke progress [0..1] weighted by stroke length
  const lengths =
    lengthsRef.current.length === item.strokes.length
      ? lengthsRef.current
      : item.strokes.map(() => 100);
  const totalLength = lengths.reduce((sum, l) => sum + l, 0) || 1;

  const strokeProgresses: number[] = [];
  let accumulated = 0;
  for (let i = 0; i < item.strokes.length; i++) {
    const segLen = lengths[i];
    const startRatio = accumulated / totalLength;
    const endRatio = (accumulated + segLen) / totalLength;
    const span = endRatio - startRatio || 0.001;
    const local = Math.max(0, Math.min(1, (drawProgress - startRatio) / span));
    strokeProgresses.push(local);
    accumulated += segLen;
  }

  // Outer 2-second beat ring math
  const ringRadius = 112;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringOffset = ringCircumference * (1 - cycleProgress);

  return (
    <div className="relative flex flex-col items-center justify-center select-none">
      {/* Main calligraphic drawing frame */}
      <div className="relative flex items-center justify-center w-[min(74vw,380px)] h-[min(74vw,380px)] sm:w-[390px] sm:h-[390px] md:w-[420px] md:h-[420px]">
        {/* Frosted luminous studio backing circle */}
        <div
          className="absolute inset-4 rounded-full bg-white/[0.08] backdrop-blur-md border border-white/20 shadow-[0_24px_80px_rgba(0,0,0,0.28)]"
          aria-hidden="true"
        />

        {/* SVG Stage */}
        <svg
          key={`${item.letter}-${drawKey}`}
          viewBox="0 0 240 240"
          className="relative z-10 h-full w-full overflow-visible"
          role="img"
          aria-label={`Рисуется буква ${item.letter}`}
        >
          <defs>
            <filter id="mix-ink-glow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <radialGradient id="mix-nib-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#FFFFFF" stopOpacity="1" />
              <stop offset="45%" stopColor={item.palette.orb} stopOpacity="0.85" />
              <stop offset="100%" stopColor={item.palette.orb} stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Subtle 2-second beat progress ring */}
          <circle
            cx="120"
            cy="120"
            r={ringRadius}
            fill="none"
            stroke="rgba(255,255,255,0.14)"
            strokeWidth="1.5"
          />
          <circle
            cx="120"
            cy="120"
            r={ringRadius}
            fill="none"
            stroke="rgba(255,255,255,0.75)"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeDasharray={ringCircumference}
            strokeDashoffset={ringOffset}
            transform="rotate(-90 120 120)"
          />

          {/* Delicate calligraphy guide lines */}
          <g stroke="rgba(255,255,255,0.13)" strokeWidth="1" strokeDasharray="3 5">
            <line x1="36" y1="42" x2="204" y2="42" />
            <line x1="36" y1="120" x2="204" y2="120" />
            <line x1="36" y1="200" x2="204" y2="200" />
            <line x1="120" y1="26" x2="120" y2="214" />
          </g>

          {/* Ghost trace guide of the letter */}
          <g fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round">
            {item.strokes.map((d, i) => (
              <path key={`ghost-${i}`} d={d} />
            ))}
          </g>

          {/* Soft colored under-glow as strokes draw */}
          <g
            fill="none"
            stroke={item.palette.glow}
            strokeWidth="22"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ filter: 'blur(7px)' }}
          >
            {item.strokes.map((d, i) => {
              const p = strokeProgresses[i] ?? 0;
              return (
                <path
                  key={`glow-${i}`}
                  d={d}
                  pathLength={1}
                  strokeDasharray="1"
                  strokeDashoffset={1 - p}
                  opacity={p > 0.005 ? 0.85 : 0}
                />
              );
            })}
          </g>

          {/* Primary crisp ink strokes */}
          <g
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="15"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#mix-ink-glow)"
          >
            {item.strokes.map((d, i) => {
              const p = strokeProgresses[i] ?? 0;
              return (
                <path
                  key={`ink-${i}`}
                  ref={(el) => {
                    pathRefs.current[i] = el;
                  }}
                  d={d}
                  pathLength={1}
                  strokeDasharray="1"
                  strokeDashoffset={1 - p}
                  opacity={p > 0.005 ? 1 : 0}
                />
              );
            })}
          </g>

          {/* Luminous brush/pen nib following the active drawing tip */}
          {nib.visible && (
            <g transform={`translate(${nib.x}, ${nib.y})`} pointerEvents="none">
              <circle r="18" fill="url(#mix-nib-glow)" />
              <circle r="6" fill="#FFFFFF" />
            </g>
          )}
        </svg>
      </div>

      {/* Clean unboxed letter caption */}
      <div className="mt-4 flex items-baseline gap-3 text-white/95">
        <span
          className="font-display text-3xl sm:text-4xl font-semibold tracking-tight"
          style={{ textShadow: '0 2px 16px rgba(0,0,0,0.22)' }}
        >
          {item.letter} {item.lower}
        </span>
        <span className="text-white/50" aria-hidden="true">
          ·
        </span>
        <span className="text-base sm:text-lg font-medium text-white/85">
          «{item.phonetic}»
        </span>
        <span className="text-white/50 hidden sm:inline" aria-hidden="true">
          ·
        </span>
        <span className="hidden sm:inline text-sm text-white/75">
          {item.palette.name}
        </span>
      </div>
    </div>
  );
}
