import React, { useState, useEffect, useRef, useCallback } from 'react';
import { VirtualJoystick } from './VirtualJoystick';
import { JoystickData, ButtonStates, GyroData } from '../types/controller';
import { RealtimeChannel } from '../utils/realtime';
import {
  Wifi,
  WifiOff,
  Zap,
  Volume2,
  VolumeX,
  Maximize2,
  Compass,
  RotateCcw,
  Shield,
  Crosshair,
  Sparkles,
  Smartphone,
} from 'lucide-react';
import { sounds } from '../utils/audio';

interface MobileControllerProps {
  roomId: string;
  onLeave?: () => void;
}

export const MobileController: React.FC<MobileControllerProps> = ({ roomId, onLeave }) => {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionText, setConnectionText] = useState('연결 중...');
  const [ping, setPing] = useState<number | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [gyroEnabled, setGyroEnabled] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hapticCount, setHapticCount] = useState(0);

  // Controller states
  const [joystick, setJoystick] = useState<JoystickData>({
    x: 0,
    y: 0,
    angle: 0,
    distance: 0,
    active: false,
  });

  const [buttons, setButtons] = useState<ButtonStates>({
    boost: false,
    action: false,
    jump: false,
    light: false,
  });

  const [gyro, setGyro] = useState<GyroData>({
    alpha: 0,
    beta: 0,
    gamma: 0,
    active: false,
  });

  // Keep ref for immediate access inside loops/callbacks
  const stateRef = useRef({ joystick, buttons, gyro });
  stateRef.current = { joystick, buttons, gyro };

  // Connect via Universal Realtime Channel (WebRTC PeerJS P2P + WebSocket)
  useEffect(() => {
    const channel = new RealtimeChannel({
      roomId,
      role: 'controller',
      name: navigator.userAgent.includes('iPhone')
        ? 'iPhone'
        : navigator.userAgent.includes('Android')
        ? 'Android'
        : '모바일 패드',
      onConnect: () => {
        setIsConnected(true);
        setPing(12);
      },
      onDisconnect: () => {
        setIsConnected(false);
      },
      onStatusChange: (status, info) => {
        if (status === 'connected') {
          setIsConnected(true);
          setPing(10);
        } else if (status === 'disconnected') {
          setIsConnected(false);
        }
        if (info) setConnectionText(info);
      },
      onMessage: (data) => {
        if (data.type === 'pong' && data.t) {
          setPing(Date.now() - data.t);
        } else if (data.type === 'device_feedback') {
          // Haptic feedback from host (e.g. crash or coin pickup!)
          if (navigator.vibrate) {
            navigator.vibrate(data.pattern || [60, 40, 60]);
          }
          setHapticCount((prev) => prev + 1);
          if (data.event === 'collect') {
            sounds.playCollect();
          } else if (data.event === 'crash') {
            sounds.playCrash();
          }
        }
      },
    });

    channelRef.current = channel;

    // Periodic ping
    const pingTimer = setInterval(() => {
      channel.send({ type: 'ping', t: Date.now() });
    }, 3000);

    return () => {
      clearInterval(pingTimer);
      channel.destroy();
      channelRef.current = null;
    };
  }, [roomId]);

  // Transmit inputs to Host via Realtime channel
  const sendInputPacket = useCallback((overrideJoystick?: JoystickData, overrideButtons?: ButtonStates) => {
    if (!channelRef.current) return;
    const currentJoy = overrideJoystick || stateRef.current.joystick;
    const currentBtn = overrideButtons || stateRef.current.buttons;
    const currentGyro = stateRef.current.gyro;

    channelRef.current.send({
      type: 'input',
      roomId,
      payload: {
        joystick: currentJoy,
        buttons: currentBtn,
        gyro: currentGyro,
        timestamp: Date.now(),
      },
    });
  }, [roomId]);

  // Joystick move handler
  const handleJoystickMove = useCallback((data: JoystickData) => {
    setJoystick(data);
    sendInputPacket(data);
  }, [sendInputPacket]);

  // Button state toggle / press
  const handleButtonDown = (buttonKey: keyof ButtonStates) => {
    if (navigator.vibrate) navigator.vibrate(20);
    sounds.playTap(buttonKey === 'boost' ? 950 : buttonKey === 'action' ? 750 : 600);

    setButtons((prev) => {
      const next = buttonKey === 'light'
        ? { ...prev, light: !prev.light }
        : { ...prev, [buttonKey]: true };
      sendInputPacket(undefined, next);
      return next;
    });
  };

  const handleButtonUp = (buttonKey: keyof ButtonStates) => {
    if (buttonKey === 'light') return; // Light is toggleable
    setButtons((prev) => {
      const next = { ...prev, [buttonKey]: false };
      sendInputPacket(undefined, next);
      return next;
    });
  };

  // Gyroscope tilt mode
  const toggleGyro = async () => {
    if (gyroEnabled) {
      setGyroEnabled(false);
      setGyro({ alpha: 0, beta: 0, gamma: 0, active: false });
      return;
    }

    try {
      // iOS 13+ permission request
      if (
        typeof DeviceOrientationEvent !== 'undefined' &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        typeof (DeviceOrientationEvent as any).requestPermission === 'function'
      ) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const permission = await (DeviceOrientationEvent as any).requestPermission();
        if (permission !== 'granted') {
          alert('자이로스코프 센서 권한이 필요합니다.');
          return;
        }
      }

      setGyroEnabled(true);
      if (navigator.vibrate) navigator.vibrate(40);
    } catch (err) {
      console.warn('Orientation permission error:', err);
      setGyroEnabled(true);
    }
  };

  // Device orientation listener
  useEffect(() => {
    if (!gyroEnabled) return;

    const handleOrientation = (e: DeviceOrientationEvent) => {
      const gamma = e.gamma || 0; // Left-Right tilt [-90, 90]
      const beta = e.beta || 0;   // Front-Back tilt [-180, 180]
      const alpha = e.alpha || 0;

      const normX = Math.max(-1, Math.min(1, gamma / 35));
      const normY = Math.max(-1, Math.min(1, (beta - 35) / 35)); // Natural hand holding tilt angle

      const gyroData: GyroData = {
        alpha,
        beta,
        gamma,
        active: true,
      };
      setGyro(gyroData);

      // If joystick is resting, gyro can drive steering!
      if (!stateRef.current.joystick.active) {
        const joyData: JoystickData = {
          x: Number(normX.toFixed(3)),
          y: Number(normY.toFixed(3)),
          angle: Math.round(((Math.atan2(normY, normX) * 180) / Math.PI + 360) % 360),
          distance: Number(Math.min(1, Math.hypot(normX, normY)).toFixed(3)),
          active: true,
        };
        setJoystick(joyData);
        sendInputPacket(joyData);
      }
    };

    window.addEventListener('deviceorientation', handleOrientation);
    return () => {
      window.removeEventListener('deviceorientation', handleOrientation);
    };
  }, [gyroEnabled, sendInputPacket]);

  // Fullscreen toggle
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950 text-slate-100 flex flex-col justify-between select-none touch-none overflow-hidden overscroll-none font-sans">
      {/* Background Cyber Accents */}
      <div className="absolute inset-0 bg-cyber-grid opacity-30 pointer-events-none" />
      <div className="absolute -top-32 -left-32 w-80 h-80 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-32 -right-32 w-80 h-80 rounded-full bg-orange-500/10 blur-3xl pointer-events-none" />

      {/* Top Status & Controls Bar */}
      <header className="relative z-20 px-4 py-2.5 bg-slate-900/80 backdrop-blur-md border-b border-slate-800 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-slate-800/80 border border-slate-700">
            {isConnected ? (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                <span className="font-mono text-emerald-400 text-[11px] font-semibold">
                  {ping !== null ? `${ping}ms` : '연결됨'}
                </span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping" />
                <WifiOff className="w-3.5 h-3.5 text-rose-400" />
                <span className="font-mono text-rose-400 text-[11px]">재연결 중...</span>
              </>
            )}
          </div>

          <div className="px-2 py-1 rounded-full bg-slate-800/60 border border-slate-700/60 font-mono text-[11px] text-slate-300">
            룸: <span className="text-cyan-400 font-bold">{roomId}</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Gyro Toggle */}
          <button
            onClick={toggleGyro}
            className={`p-2 rounded-lg border text-xs transition-colors flex items-center gap-1 ${
              gyroEnabled
                ? 'bg-cyan-500/20 border-cyan-400 text-cyan-300 shadow-[0_0_12px_rgba(6,182,212,0.4)]'
                : 'bg-slate-800 border-slate-700 text-slate-400 active:bg-slate-700'
            }`}
            title="스마트폰 자이로 기울기 조종 모드"
          >
            <Compass className={`w-4 h-4 ${gyroEnabled ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline font-mono text-[10px]">자이로</span>
          </button>

          {/* Sound Mute */}
          <button
            onClick={() => {
              const next = !isMuted;
              setIsMuted(next);
              sounds.setMuted(next);
            }}
            className="p-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 active:bg-slate-700"
          >
            {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4 text-cyan-400" />}
          </button>

          {/* Fullscreen */}
          <button
            onClick={toggleFullscreen}
            className="p-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 active:bg-slate-700"
          >
            <Maximize2 className="w-4 h-4" />
          </button>

          {/* Switch to Host / Leave */}
          {onLeave && (
            <button
              onClick={onLeave}
              className="p-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 active:bg-slate-700"
              title="화면으로 전환"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          )}
        </div>
      </header>

      {/* Main Touch Playfield - Splits cleanly into Left (Joystick) and Right (Action Buttons) */}
      <main className="relative z-10 flex-1 flex flex-col md:flex-row items-center justify-around px-4 py-2 gap-4">
        {/* Left Side: Analog Virtual Joystick */}
        <div className="flex-1 flex flex-col items-center justify-center w-full max-w-sm">
          <VirtualJoystick
            size={220}
            onMove={handleJoystickMove}
            color="#06b6d4"
            label="아날로그 조이스틱 (STEER)"
          />
        </div>

        {/* Right Side: Tactile Action Buttons Cluster */}
        <div className="flex-1 flex flex-col items-center justify-center w-full max-w-sm">
          <div className="text-[11px] font-mono tracking-widest uppercase text-slate-400 mb-3 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-orange-400" />
            <span>액션 컨트롤러 (ACTION PAD)</span>
          </div>

          <div className="grid grid-cols-2 gap-3.5 w-64">
            {/* NITRO BOOST BUTTON (Top-Right priority) */}
            <button
              onPointerDown={() => handleButtonDown('boost')}
              onPointerUp={() => handleButtonUp('boost')}
              onPointerCancel={() => handleButtonUp('boost')}
              className={`col-span-2 relative group overflow-hidden py-4 px-5 rounded-2xl border-2 font-mono font-bold uppercase transition-all duration-75 flex items-center justify-center gap-2 select-none touch-none ${
                buttons.boost
                  ? 'bg-gradient-to-r from-orange-500 to-amber-500 border-amber-300 text-white shadow-[0_0_35px_rgba(249,115,22,0.8)] scale-95'
                  : 'bg-gradient-to-r from-slate-900 to-slate-800 border-orange-500/50 text-orange-400 shadow-lg active:scale-95'
              }`}
            >
              <Zap className={`w-5 h-5 ${buttons.boost ? 'fill-white animate-bounce' : 'fill-orange-400'}`} />
              <span className="text-base tracking-wider">NITRO BOOST</span>
              <span className="text-[10px] opacity-75 font-normal ml-1">누르고 있기</span>
            </button>

            {/* ACTION / SHOOT / HONK BUTTON */}
            <button
              onPointerDown={() => handleButtonDown('action')}
              onPointerUp={() => handleButtonUp('action')}
              onPointerCancel={() => handleButtonUp('action')}
              className={`relative overflow-hidden py-4 px-3 rounded-2xl border-2 font-mono font-bold text-sm uppercase transition-all duration-75 flex flex-col items-center justify-center gap-1 select-none touch-none ${
                buttons.action
                  ? 'bg-rose-600 border-rose-300 text-white shadow-[0_0_30px_rgba(244,63,94,0.8)] scale-95'
                  : 'bg-slate-900 border-rose-500/50 text-rose-400 shadow-md active:scale-95'
              }`}
            >
              <Crosshair className="w-5 h-5" />
              <span>발사 / 액션</span>
            </button>

            {/* JUMP / DRIFT BUTTON */}
            <button
              onPointerDown={() => handleButtonDown('jump')}
              onPointerUp={() => handleButtonUp('jump')}
              onPointerCancel={() => handleButtonUp('jump')}
              className={`relative overflow-hidden py-4 px-3 rounded-2xl border-2 font-mono font-bold text-sm uppercase transition-all duration-75 flex flex-col items-center justify-center gap-1 select-none touch-none ${
                buttons.jump
                  ? 'bg-violet-600 border-violet-300 text-white shadow-[0_0_30px_rgba(139,92,246,0.8)] scale-95'
                  : 'bg-slate-900 border-violet-500/50 text-violet-400 shadow-md active:scale-95'
              }`}
            >
              <Sparkles className="w-5 h-5" />
              <span>점프 / 회전</span>
            </button>

            {/* HEADLIGHTS / SHIELD TOGGLE BUTTON */}
            <button
              onPointerDown={() => handleButtonDown('light')}
              className={`col-span-2 py-2.5 px-3 rounded-xl border font-mono text-xs uppercase transition-all duration-75 flex items-center justify-center gap-2 select-none touch-none ${
                buttons.light
                  ? 'bg-cyan-500/20 border-cyan-400 text-cyan-300 shadow-[0_0_15px_rgba(6,182,212,0.4)]'
                  : 'bg-slate-900/80 border-slate-700 text-slate-400 active:bg-slate-800'
              }`}
            >
              <Shield className={`w-4 h-4 ${buttons.light ? 'text-cyan-400 fill-cyan-400/30' : ''}`} />
              <span>헤드라이트 / 보호막 {buttons.light ? '[ON]' : '[OFF]'}</span>
            </button>
          </div>
        </div>
      </main>

      {/* Bottom Bar: Instructions & Haptic Flash */}
      <footer className="relative z-20 px-4 py-2 bg-slate-950/90 border-t border-slate-800 text-[11px] flex items-center justify-between text-slate-400">
        <div className="flex items-center gap-1.5">
          <Smartphone className="w-3.5 h-3.5 text-cyan-400" />
          <span>모바일 터치 패드 활성화됨</span>
        </div>
        <div className="font-mono text-[10px] text-slate-500">
          {hapticCount > 0 && (
            <span className="text-orange-400 mr-2">진동 수신 {hapticCount}회</span>
          )}
          화면을 보며 조종하세요!
        </div>
      </footer>
    </div>
  );
};
