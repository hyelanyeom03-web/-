import React, { useRef, useState, useCallback, useEffect } from 'react';
import { JoystickData } from '../types/controller';

interface VirtualJoystickProps {
  onMove: (data: JoystickData) => void;
  size?: number; // Outer diameter in pixels
  color?: string; // Theme accent color
  label?: string;
}

export const VirtualJoystick: React.FC<VirtualJoystickProps> = ({
  onMove,
  size = 200,
  color = '#06b6d4',
  label = '방향 조종 (STEERING)',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const pointerIdRef = useRef<number | null>(null);
  const [knobPos, setKnobPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isActive, setIsActive] = useState(false);
  const [currentAngle, setCurrentAngle] = useState(0);
  const [currentDistance, setCurrentDistance] = useState(0);

  const radius = size / 2;
  const maxTravel = radius * 0.75; // Maximum distance the knob can move from center

  const updatePosition = useCallback((clientX: number, clientY: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const deltaX = clientX - centerX;
    const deltaY = clientY - centerY;

    const dist = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    const clampedDist = Math.min(dist, maxTravel);

    let angleRad = Math.atan2(deltaY, deltaX);
    let angleDeg = (angleRad * 180) / Math.PI;
    if (angleDeg < 0) angleDeg += 360;

    const normDist = clampedDist / maxTravel;
    const normX = clampedDist > 0 ? (deltaX / dist) * normDist : 0;
    const normY = clampedDist > 0 ? (deltaY / dist) * normDist : 0;

    // Apply deadzone (5%)
    const deadzone = 0.05;
    const finalDist = normDist < deadzone ? 0 : (normDist - deadzone) / (1 - deadzone);
    const finalX = normDist < deadzone ? 0 : normX;
    const finalY = normDist < deadzone ? 0 : normY;

    const knobX = clampedDist > 0 ? (deltaX / dist) * clampedDist : 0;
    const knobY = clampedDist > 0 ? (deltaY / dist) * clampedDist : 0;

    setKnobPos({ x: knobX, y: knobY });
    setCurrentAngle(Math.round(angleDeg));
    setCurrentDistance(Number(finalDist.toFixed(2)));

    onMove({
      x: Number(finalX.toFixed(3)),
      y: Number(finalY.toFixed(3)),
      angle: Math.round(angleDeg),
      distance: Number(finalDist.toFixed(3)),
      active: true,
    });
  }, [maxTravel, onMove]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (pointerIdRef.current !== null) return;

    pointerIdRef.current = e.pointerId;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsActive(true);

    if (navigator.vibrate) {
      navigator.vibrate(15);
    }

    updatePosition(e.clientX, e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    updatePosition(e.clientX, e.clientY);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore if capture already lost
    }
    pointerIdRef.current = null;
    setIsActive(false);
    setKnobPos({ x: 0, y: 0 });
    setCurrentDistance(0);

    onMove({
      x: 0,
      y: 0,
      angle: currentAngle,
      distance: 0,
      active: false,
    });
  };

  // Safety fallback if pointerup was missed
  useEffect(() => {
    const handleGlobalUp = () => {
      if (pointerIdRef.current !== null) {
        pointerIdRef.current = null;
        setIsActive(false);
        setKnobPos({ x: 0, y: 0 });
        setCurrentDistance(0);
        onMove({
          x: 0,
          y: 0,
          angle: 0,
          distance: 0,
          active: false,
        });
      }
    };
    window.addEventListener('pointerup', handleGlobalUp);
    window.addEventListener('pointercancel', handleGlobalUp);
    return () => {
      window.removeEventListener('pointerup', handleGlobalUp);
      window.removeEventListener('pointercancel', handleGlobalUp);
    };
  }, [onMove]);

  return (
    <div className="flex flex-col items-center select-none touch-none">
      {label && (
        <div className="text-[11px] font-mono tracking-widest uppercase text-slate-400 mb-2.5 flex items-center gap-2">
          <span>{label}</span>
          {isActive && (
            <span className="inline-block w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
          )}
        </div>
      )}

      {/* Main Joystick Base */}
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ width: size, height: size }}
        className={`relative rounded-full flex items-center justify-center cursor-pointer transition-shadow touch-none ${
          isActive
            ? 'shadow-[0_0_35px_rgba(6,182,212,0.4)] border-cyan-500/60 bg-slate-900/90'
            : 'shadow-lg border-slate-700/60 bg-slate-900/60'
        } border-2 backdrop-blur-md`}
      >
        {/* Cardinal Direction Indicators */}
        <div className="absolute top-2 text-[9px] font-mono text-slate-500 font-bold">▲ FWD</div>
        <div className="absolute bottom-2 text-[9px] font-mono text-slate-500 font-bold">▼ REV</div>
        <div className="absolute left-2 text-[9px] font-mono text-slate-500 font-bold">◀ L</div>
        <div className="absolute right-2 text-[9px] font-mono text-slate-500 font-bold">R ▶</div>

        {/* Concentric rings */}
        <div className="absolute inset-5 rounded-full border border-dashed border-slate-700/50 pointer-events-none" />
        <div className="absolute inset-10 rounded-full border border-slate-800 pointer-events-none" />

        {/* Active Vector Guide Line */}
        {isActive && currentDistance > 0.05 && (
          <div
            className="absolute h-0.5 bg-gradient-to-r from-transparent via-cyan-400/80 to-cyan-300 pointer-events-none origin-left"
            style={{
              width: `${Math.hypot(knobPos.x, knobPos.y)}px`,
              left: `${radius}px`,
              top: `${radius}px`,
              transform: `rotate(${Math.atan2(knobPos.y, knobPos.x)}rad)`,
            }}
          />
        )}

        {/* Dynamic Glowing Thumbstick Knob */}
        <div
          className={`absolute rounded-full flex items-center justify-center pointer-events-none transition-transform duration-75 ${
            isActive
              ? 'scale-105 shadow-[0_0_25px_rgba(6,182,212,0.8)] ring-2 ring-cyan-300'
              : 'shadow-md ring-1 ring-slate-600'
          }`}
          style={{
            width: size * 0.4,
            height: size * 0.4,
            transform: `translate(${knobPos.x}px, ${knobPos.y}px)`,
            background: isActive
              ? 'radial-gradient(circle at 35% 35%, #38bdf8 0%, #0284c7 60%, #0369a1 100%)'
              : 'radial-gradient(circle at 35% 35%, #475569 0%, #334155 70%, #1e293b 100%)',
          }}
        >
          {/* Thumb grip textures */}
          <div className="w-6 h-6 rounded-full border border-white/30 flex items-center justify-center">
            <div className="w-2 h-2 rounded-full bg-white/70" />
          </div>

          {/* Direction indicator arrow when moving */}
          {isActive && currentDistance > 0.15 && (
            <div
              className="absolute -top-3 w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-b-[8px] border-b-cyan-200"
              style={{
                transform: `rotate(${currentAngle + 90}deg)`,
                transformOrigin: '50% 32px',
              }}
            />
          )}
        </div>
      </div>

      {/* Telemetry Readout under Joystick */}
      <div className="mt-3 flex items-center justify-center gap-3 text-[11px] font-mono text-slate-400">
        <span className="bg-slate-900/80 px-2 py-0.5 rounded border border-slate-800">
          PWR <span className="text-cyan-400 font-semibold">{Math.round(currentDistance * 100)}%</span>
        </span>
        <span className="bg-slate-900/80 px-2 py-0.5 rounded border border-slate-800">
          ANG <span className="text-emerald-400 font-semibold">{currentAngle}°</span>
        </span>
      </div>
    </div>
  );
};
