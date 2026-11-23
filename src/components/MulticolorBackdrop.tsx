import { useEffect, useState } from 'react';
import type { LetterPalette } from '../data/alphabet';

interface MulticolorBackdropProps {
  palette: LetterPalette;
}

export function MulticolorBackdrop({ palette }: MulticolorBackdropProps) {
  const [layers, setLayers] = useState<{
    base: LetterPalette;
    overlay: LetterPalette;
    showOverlay: boolean;
  }>({
    base: palette,
    overlay: palette,
    showOverlay: true,
  });

  useEffect(() => {
    setLayers((prev) => ({
      base: prev.showOverlay ? prev.overlay : prev.base,
      overlay: palette,
      showOverlay: false,
    }));

    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setLayers((prev) => ({
          ...prev,
          showOverlay: true,
        }));
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [palette]);

  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
      {/* Previous palette base layer */}
      <div
        className="absolute inset-0"
        style={{
          background: `linear-gradient(135deg, ${layers.base.c1} 0%, ${layers.base.c2} 52%, ${layers.base.c3} 100%)`,
        }}
      />

      {/* Incoming palette cross-fade layer */}
      <div
        className="absolute inset-0 transition-opacity duration-900 ease-out"
        style={{
          opacity: layers.showOverlay ? 1 : 0,
          background: `linear-gradient(135deg, ${layers.overlay.c1} 0%, ${layers.overlay.c2} 52%, ${layers.overlay.c3} 100%)`,
        }}
      />

      {/* Multicolor ambient drifting radial washes */}
      <div
        className="animate-orb-a absolute -top-1/4 -left-1/6 h-[70vmax] w-[70vmax] rounded-full opacity-35 blur-3xl transition-colors duration-1000"
        style={{
          background: `radial-gradient(circle, ${palette.orb} 0%, transparent 68%)`,
        }}
      />
      <div
        className="animate-orb-b absolute -right-1/6 -bottom-1/4 h-[65vmax] w-[65vmax] rounded-full opacity-30 blur-3xl transition-colors duration-1000"
        style={{
          background: `radial-gradient(circle, ${palette.c3} 0%, transparent 70%)`,
        }}
      />

      {/* Subtle vignette for deep studio focus */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 50% 48%, transparent 32%, rgba(8, 12, 24, 0.34) 100%)',
        }}
      />

      {/* Crisp micro-grid texture */}
      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'radial-gradient(rgba(255, 255, 255, 0.9) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />
    </div>
  );
}
