import React, { useState, useEffect, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import confetti from 'canvas-confetti';
import {
  Gamepad2,
  QrCode,
  Smartphone,
  ExternalLink,
  Copy,
  Check,
  Volume2,
  VolumeX,
  Gauge,
  Rocket,
  Plane,
  Activity,
  Zap,
  Shield,
  Crosshair,
  Sparkles,
  Wifi,
  Radio,
} from 'lucide-react';
import { JoystickData, ButtonStates, GyroData } from '../types/controller';
import { sounds } from '../utils/audio';
import { RealtimeChannel } from '../utils/realtime';

interface HostScreenProps {
  roomId: string;
  onSwitchToController: () => void;
}

type GameMode = 'hovercraft' | 'drone' | 'space' | 'diagnostics';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

interface Collectible {
  id: number;
  x: number;
  y: number;
  radius: number;
  pulse: number;
}

interface Obstacle {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

interface Target {
  x: number;
  y: number;
  radius: number;
  vx: number;
  vy: number;
  health: number;
}

interface Laser {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

export const HostScreen: React.FC<HostScreenProps> = ({ roomId, onSwitchToController }) => {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Connection & Controller state
  const [controllerConnected, setControllerConnected] = useState(false);
  const [controllerDevice, setControllerDevice] = useState<string>('모바일 기기');
  const [controllerLatency, setControllerLatency] = useState<number>(12);
  const [connectionStatusText, setConnectionStatusText] = useState<string>('연결 대기 중');
  const [gameMode, setGameMode] = useState<GameMode>('hovercraft');
  const [isMuted, setIsMuted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [score, setScore] = useState(0);
  const [isQrModalOpen, setIsQrModalOpen] = useState(false);
  const [showDesktopTester, setShowDesktopTester] = useState(false);

  // Active inputs received from mobile controller
  const inputRef = useRef<{
    joystick: JoystickData;
    buttons: ButtonStates;
    gyro?: GyroData;
    lastReceived: number;
  }>({
    joystick: { x: 0, y: 0, angle: 0, distance: 0, active: false },
    buttons: { boost: false, action: false, jump: false, light: true },
    lastReceived: 0,
  });

  // Packet counter for telemetry
  const [packetCount, setPacketCount] = useState(0);
  const [latestInput, setLatestInput] = useState<JoystickData>({
    x: 0,
    y: 0,
    angle: 0,
    distance: 0,
    active: false,
  });
  const [latestButtons, setLatestButtons] = useState<ButtonStates>({
    boost: false,
    action: false,
    jump: false,
    light: true,
  });

  // URL for QR Code: Use window.location.href to preserve subpaths (crucial for GitHub Pages /repo-name/!)
  const getControllerUrl = () => {
    try {
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set('mode', 'controller');
      currentUrl.searchParams.set('room', roomId);
      return currentUrl.toString();
    } catch {
      return `${window.location.origin}${window.location.pathname}?mode=controller&room=${encodeURIComponent(roomId)}`;
    }
  };
  const controllerUrl = getControllerUrl();

  // Copy link
  const handleCopyLink = () => {
    navigator.clipboard.writeText(controllerUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Trigger haptic feedback to phone via Realtime channel
  const sendHapticToController = useCallback((event: string, pattern: number[] = [40, 20, 40]) => {
    if (channelRef.current) {
      channelRef.current.send({
        type: 'device_feedback',
        roomId,
        event,
        pattern,
      });
    }
  }, [roomId]);

  // Connect Host via Hybrid Realtime Channel (WebRTC PeerJS P2P + WebSocket fallback)
  useEffect(() => {
    const channel = new RealtimeChannel({
      roomId,
      role: 'host',
      name: 'Main Screen Display',
      onStatusChange: (_status, info) => {
        if (info) setConnectionStatusText(info);
      },
      onConnect: () => {
        // Ready for peers
      },
      onDisconnect: () => {
        setControllerConnected(false);
      },
      onMessage: (data) => {
        if (data.type === 'peer_joined') {
          if (data.role === 'controller') {
            setControllerConnected(true);
            setControllerDevice(data.name || '스마트폰');
            confetti({ particleCount: 50, spread: 60, origin: { y: 0.8 } });
            sounds.playCollect();
          }
        } else if (data.type === 'peer_left') {
          if (data.role === 'controller' && (data.totalInRoom === undefined || data.totalInRoom <= 1)) {
            setControllerConnected(false);
          }
        } else if (data.type === 'controller_input' || data.type === 'input') {
          setControllerConnected(true);
          const p = data.payload || data;
          if (p && p.joystick) {
            inputRef.current.joystick = p.joystick;
            inputRef.current.buttons = p.buttons || inputRef.current.buttons;
            inputRef.current.gyro = p.gyro;
            inputRef.current.lastReceived = Date.now();

            setLatestInput(p.joystick);
            if (p.buttons) setLatestButtons(p.buttons);
            setPacketCount((c) => c + 1);

            if (p.timestamp) {
              const lat = Math.max(1, Math.min(200, Date.now() - p.timestamp));
              setControllerLatency(lat);
            }
          }
        }
      },
    });

    channelRef.current = channel;

    return () => {
      channel.destroy();
      channelRef.current = null;
    };
  }, [roomId]);

  // Main Canvas Physics & Simulation Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;

    // Responsive Canvas Resizing
    const handleResize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };
    handleResize();
    window.addEventListener('resize', handleResize);

    // Simulation Entities
    const vehicle = {
      x: 400,
      y: 300,
      vx: 0,
      vy: 0,
      angle: 0,
      targetAngle: 0,
      speed: 0,
      maxSpeed: 7,
      boostSpeed: 14,
      jumpHeight: 0,
      isJumping: false,
      driftParticles: [] as Particle[],
      boostParticles: [] as Particle[],
    };

    // Targets & Lasers for shooting
    const targets: Target[] = [
      { x: 200, y: 150, radius: 25, vx: 1.2, vy: 0.8, health: 3 },
      { x: 600, y: 200, radius: 30, vx: -1.0, vy: 1.1, health: 3 },
      { x: 400, y: 100, radius: 20, vx: 0.8, vy: -0.9, health: 2 },
    ];
    const lasers: Laser[] = [];
    let lastShootTime = 0;

    // Collectibles (Energy Orbs)
    const collectibles: Collectible[] = [
      { id: 1, x: 250, y: 200, radius: 14, pulse: 0 },
      { id: 2, x: 550, y: 350, radius: 14, pulse: 1.2 },
      { id: 3, x: 700, y: 150, radius: 14, pulse: 2.4 },
      { id: 4, x: 200, y: 450, radius: 14, pulse: 3.6 },
      { id: 5, x: 600, y: 500, radius: 14, pulse: 4.8 },
    ];

    // Obstacles
    const obstacles: Obstacle[] = [
      { x: 320, y: 180, w: 50, h: 50, color: '#f43f5e' },
      { x: 480, y: 320, w: 60, h: 60, color: '#f43f5e' },
      { x: 180, y: 320, w: 40, h: 40, color: '#06b6d4' },
    ];

    let lastJumpState = false;

    // Main 60fps Loop
    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;

      // Extract current joystick input
      const joy = inputRef.current.joystick;
      const btns = inputRef.current.buttons;

      // Jump trigger
      if (btns.jump && !lastJumpState && !vehicle.isJumping) {
        vehicle.isJumping = true;
        vehicle.jumpHeight = 1;
        sounds.playTap(440, 0.1);
        sendHapticToController('jump', [30, 20]);
      }
      lastJumpState = btns.jump;

      if (vehicle.isJumping) {
        vehicle.jumpHeight += 0.8;
        if (vehicle.jumpHeight > 25) {
          vehicle.jumpHeight = 0;
          vehicle.isJumping = false;
        }
      }

      // Action / Shoot trigger
      if (btns.action && Date.now() - lastShootTime > 220) {
        lastShootTime = Date.now();
        sounds.playLaser();
        sendHapticToController('shoot', [20]);

        const speed = 16;
        lasers.push({
          x: vehicle.x + Math.cos(vehicle.angle) * 20,
          y: vehicle.y + Math.sin(vehicle.angle) * 20,
          vx: Math.cos(vehicle.angle) * speed,
          vy: Math.sin(vehicle.angle) * speed,
          life: 45,
        });
      }

      // Physics based on Joystick
      const maxSpd = btns.boost ? vehicle.boostSpeed : vehicle.maxSpeed;
      const accel = btns.boost ? 0.9 : 0.45;
      const friction = 0.94;

      if (joy.active && joy.distance > 0.05) {
        // Direct stick propulsion
        const targetVx = joy.x * maxSpd;
        const targetVy = joy.y * maxSpd;
        vehicle.vx += (targetVx - vehicle.vx) * accel;
        vehicle.vy += (targetVy - vehicle.vy) * accel;

        // Smooth steering angle
        vehicle.targetAngle = Math.atan2(joy.y, joy.x);
        let diff = vehicle.targetAngle - vehicle.angle;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        vehicle.angle += diff * 0.2;

        // Sound update
        const speedRatio = Math.min(1, Math.hypot(vehicle.vx, vehicle.vy) / vehicle.boostSpeed);
        sounds.updateEngine(speedRatio, btns.boost);
      } else {
        // Friction dampening
        vehicle.vx *= friction;
        vehicle.vy *= friction;
        const speedRatio = Math.min(1, Math.hypot(vehicle.vx, vehicle.vy) / vehicle.boostSpeed);
        sounds.updateEngine(speedRatio * 0.3, false);
      }

      // Position update
      vehicle.x += vehicle.vx;
      vehicle.y += vehicle.vy;

      // Screen boundary wrap / bounce
      const padding = 20;
      if (vehicle.x < padding) {
        vehicle.x = padding;
        vehicle.vx = -vehicle.vx * 0.5;
        sendHapticToController('crash', [50]);
        sounds.playCrash();
      }
      if (vehicle.x > width - padding) {
        vehicle.x = width - padding;
        vehicle.vx = -vehicle.vx * 0.5;
        sendHapticToController('crash', [50]);
        sounds.playCrash();
      }
      if (vehicle.y < padding) {
        vehicle.y = padding;
        vehicle.vy = -vehicle.vy * 0.5;
        sendHapticToController('crash', [50]);
        sounds.playCrash();
      }
      if (vehicle.y > height - padding) {
        vehicle.y = height - padding;
        vehicle.vy = -vehicle.vy * 0.5;
        sendHapticToController('crash', [50]);
        sounds.playCrash();
      }

      // Obstacle collision
      obstacles.forEach((obs) => {
        if (
          vehicle.x > obs.x - 18 &&
          vehicle.x < obs.x + obs.w + 18 &&
          vehicle.y > obs.y - 18 &&
          vehicle.y < obs.y + obs.h + 18
        ) {
          vehicle.vx = -vehicle.vx * 1.2;
          vehicle.vy = -vehicle.vy * 1.2;
          sounds.playCrash();
          sendHapticToController('crash', [80, 50, 80]);
        }
      });

      // Collectibles check
      collectibles.forEach((c) => {
        const dist = Math.hypot(vehicle.x - c.x, vehicle.y - c.y);
        if (dist < c.radius + 18) {
          // Collected!
          sounds.playCollect();
          sendHapticToController('collect', [40, 20, 60]);
          setScore((s) => s + 100);

          // Respawn in a random valid spot
          c.x = 60 + Math.random() * (width - 120);
          c.y = 60 + Math.random() * (height - 120);

          // Burst particles
          for (let p = 0; p < 12; p++) {
            vehicle.driftParticles.push({
              x: vehicle.x,
              y: vehicle.y,
              vx: (Math.random() - 0.5) * 6,
              vy: (Math.random() - 0.5) * 6,
              life: 1,
              maxLife: 20 + Math.random() * 15,
              color: '#38bdf8',
              size: 3 + Math.random() * 3,
            });
          }
        }
      });

      // Target movement & Laser hits
      targets.forEach((tgt) => {
        tgt.x += tgt.vx;
        tgt.y += tgt.vy;
        if (tgt.x < 50 || tgt.x > width - 50) tgt.vx = -tgt.vx;
        if (tgt.y < 50 || tgt.y > height - 50) tgt.vy = -tgt.vy;
      });

      for (let l = lasers.length - 1; l >= 0; l--) {
        const laser = lasers[l];
        laser.x += laser.vx;
        laser.y += laser.vy;
        laser.life--;

        // Check target hit
        let hit = false;
        targets.forEach((tgt) => {
          if (Math.hypot(laser.x - tgt.x, laser.y - tgt.y) < tgt.radius) {
            hit = true;
            tgt.health--;
            sounds.playCrash();
            sendHapticToController('hit', [70]);
            setScore((s) => s + 250);

            if (tgt.health <= 0) {
              tgt.x = 80 + Math.random() * (width - 160);
              tgt.y = 80 + Math.random() * (height - 160);
              tgt.health = 3;
            }
          }
        });

        if (hit || laser.life <= 0) {
          lasers.splice(l, 1);
        }
      }

      // Add Exhaust / Drift Particles
      if (joy.active && joy.distance > 0.1) {
        const isBoost = btns.boost;
        const color = isBoost ? '#f97316' : '#06b6d4';
        vehicle.boostParticles.push({
          x: vehicle.x - Math.cos(vehicle.angle) * 16,
          y: vehicle.y - Math.sin(vehicle.angle) * 16,
          vx: -Math.cos(vehicle.angle) * (isBoost ? 6 : 3) + (Math.random() - 0.5) * 2,
          vy: -Math.sin(vehicle.angle) * (isBoost ? 6 : 3) + (Math.random() - 0.5) * 2,
          life: 1,
          maxLife: isBoost ? 25 : 15,
          color,
          size: isBoost ? 6 : 3.5,
        });
      }

      // CLEAR SCREEN & DRAW
      ctx.clearRect(0, 0, width, height);

      // 1. Cyber Grid Floor
      ctx.save();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.06)';
      ctx.lineWidth = 1;
      const gridSize = 40;
      for (let x = 0; x < width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y < height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      ctx.restore();

      // 2. Draw Obstacles
      obstacles.forEach((obs) => {
        ctx.save();
        ctx.shadowColor = obs.color;
        ctx.shadowBlur = 12;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.strokeStyle = obs.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(obs.x, obs.y, obs.w, obs.h, 8);
        ctx.fill();
        ctx.stroke();

        // Hazard diagonal stripes inside
        ctx.strokeStyle = obs.color;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(obs.x + 6, obs.y + 6, obs.w - 12, obs.h - 12);
        ctx.restore();
      });

      // 3. Draw Collectibles (Glowing Energy Orbs)
      collectibles.forEach((c) => {
        c.pulse += 0.05;
        const currentR = c.radius + Math.sin(c.pulse) * 2;
        ctx.save();
        ctx.shadowColor = '#38bdf8';
        ctx.shadowBlur = 18;

        const grad = ctx.createRadialGradient(c.x, c.y, 2, c.x, c.y, currentR);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.4, '#38bdf8');
        grad.addColorStop(1, 'rgba(6, 182, 212, 0.1)');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(c.x, c.y, currentR, 0, Math.PI * 2);
        ctx.fill();

        // Orbiting halo
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(c.x, c.y, currentR + 6, c.pulse, c.pulse + Math.PI);
        ctx.stroke();
        ctx.restore();
      });

      // 4. Draw Targets
      targets.forEach((tgt) => {
        ctx.save();
        ctx.shadowColor = '#f43f5e';
        ctx.shadowBlur = 15;
        ctx.strokeStyle = '#f43f5e';
        ctx.lineWidth = 2;
        ctx.fillStyle = 'rgba(244, 63, 94, 0.15)';
        ctx.beginPath();
        ctx.arc(tgt.x, tgt.y, tgt.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Crosshairs in target
        ctx.beginPath();
        ctx.moveTo(tgt.x - tgt.radius - 4, tgt.y);
        ctx.lineTo(tgt.x + tgt.radius + 4, tgt.y);
        ctx.moveTo(tgt.x, tgt.y - tgt.radius - 4);
        ctx.lineTo(tgt.x, tgt.y + tgt.radius + 4);
        ctx.stroke();
        ctx.restore();
      });

      // 5. Draw Lasers
      lasers.forEach((laser) => {
        ctx.save();
        ctx.shadowColor = '#fb7185';
        ctx.shadowBlur = 12;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(laser.x, laser.y);
        ctx.lineTo(laser.x - laser.vx * 0.8, laser.y - laser.vy * 0.8);
        ctx.stroke();
        ctx.restore();
      });

      // 6. Draw Exhaust & Boost Particles
      const allParticles = [...vehicle.driftParticles, ...vehicle.boostParticles];
      for (let i = allParticles.length - 1; i >= 0; i--) {
        const p = allParticles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life += 1;

        const alpha = Math.max(0, 1 - p.life / p.maxLife);
        ctx.save();
        ctx.fillStyle = p.color;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        if (p.life >= p.maxLife) {
          allParticles.splice(i, 1);
        }
      }
      vehicle.driftParticles = allParticles.filter((p) => p.color === '#38bdf8');
      vehicle.boostParticles = allParticles.filter((p) => p.color !== '#38bdf8');

      // 7. Draw Headlight Cone (if light enabled)
      if (btns.light) {
        ctx.save();
        const lightLen = 160;
        const spread = Math.PI / 4;
        const grad = ctx.createRadialGradient(vehicle.x, vehicle.y, 10, vehicle.x, vehicle.y, lightLen);
        grad.addColorStop(0, 'rgba(56, 189, 248, 0.45)');
        grad.addColorStop(0.7, 'rgba(56, 189, 248, 0.12)');
        grad.addColorStop(1, 'rgba(56, 189, 248, 0)');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(vehicle.x, vehicle.y);
        ctx.arc(vehicle.x, vehicle.y, lightLen, vehicle.angle - spread / 2, vehicle.angle + spread / 2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      // 8. Draw Vehicle / Drone / Fighter
      ctx.save();
      ctx.translate(vehicle.x, vehicle.y - vehicle.jumpHeight);
      ctx.rotate(vehicle.angle);

      // Shadow when jumping
      if (vehicle.isJumping) {
        ctx.save();
        ctx.translate(0, vehicle.jumpHeight);
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.beginPath();
        ctx.ellipse(0, 0, 22, 12, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      if (gameMode === 'drone') {
        // Quadcopter Drone Render
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 3;
        // Arms
        ctx.beginPath();
        ctx.moveTo(-18, -18);
        ctx.lineTo(18, 18);
        ctx.moveTo(18, -18);
        ctx.lineTo(-18, 18);
        ctx.stroke();

        // 4 Rotors
        const rotorSpin = (Date.now() * 0.05) % (Math.PI * 2);
        [
          [-18, -18],
          [18, -18],
          [-18, 18],
          [18, 18],
        ].forEach(([rx, ry]) => {
          ctx.save();
          ctx.translate(rx, ry);
          ctx.rotate(rotorSpin);
          ctx.strokeStyle = 'rgba(255,255,255,0.7)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(-8, 0);
          ctx.lineTo(8, 0);
          ctx.stroke();
          ctx.restore();
        });

        // Drone central pod
        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.arc(0, 0, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#38bdf8';
        ctx.stroke();
      } else {
        // Futuristic Cyber Hovercraft / Speeder
        ctx.shadowColor = btns.boost ? '#f97316' : '#06b6d4';
        ctx.shadowBlur = btns.boost ? 25 : 15;

        // Hull
        ctx.fillStyle = '#0f172a';
        ctx.strokeStyle = btns.boost ? '#fb923c' : '#38bdf8';
        ctx.lineWidth = 2.5;

        ctx.beginPath();
        ctx.moveTo(22, 0); // Nose tip
        ctx.lineTo(4, -14); // Left wing
        ctx.lineTo(-18, -16); // Left rear fin
        ctx.lineTo(-12, 0); // Center exhaust
        ctx.lineTo(-18, 16); // Right rear fin
        ctx.lineTo(4, 14); // Right wing
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Cockpit canopy
        ctx.fillStyle = btns.boost ? '#f97316' : '#06b6d4';
        ctx.beginPath();
        ctx.ellipse(2, 0, 7, 4, 0, 0, Math.PI * 2);
        ctx.fill();

        // Shield dome if shield/light toggled
        if (btns.light) {
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(0, 0, 26, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      ctx.restore();

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
      sounds.stopEngine();
    };
  }, [gameMode, sendHapticToController]);

  return (
    <div className="relative w-full h-screen bg-slate-950 text-slate-100 flex flex-col overflow-hidden font-sans select-none">
      {/* Top Header / Status bar */}
      <header className="relative z-30 px-6 py-3.5 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center shadow-[0_0_20px_rgba(6,182,212,0.4)]">
            <Gamepad2 className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold tracking-tight text-white">QR 조이스틱 컨트롤러</h1>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-semibold">
                ROOM: {roomId}
              </span>
            </div>
            <p className="text-xs text-slate-400">핸드폰으로 QR을 스캔하여 무선 조이스틱으로 실시간 조종하세요</p>
          </div>
        </div>

        {/* Status Badges & Controls */}
        <div className="flex items-center gap-3">
          {/* Connection Pill */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800/80 border border-slate-700">
            {controllerConnected ? (
              <>
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                <Smartphone className="w-4 h-4 text-emerald-400" />
                <span className="text-xs font-semibold text-emerald-400">{controllerDevice} 연결됨</span>
                <span className="text-[11px] font-mono text-slate-400">({controllerLatency}ms)</span>
              </>
            ) : (
              <>
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping" />
                <Radio className="w-4 h-4 text-amber-400" />
                <span className="text-xs font-medium text-amber-300">핸드폰 접속 대기 중</span>
              </>
            )}
          </div>

          {/* Score display */}
          <div className="px-3 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/60 font-mono text-xs">
            점수: <span className="text-cyan-400 font-bold text-sm">{score.toLocaleString()}</span>
          </div>

          {/* Sound Toggle */}
          <button
            onClick={() => {
              const next = !isMuted;
              setIsMuted(next);
              sounds.setMuted(next);
            }}
            className="p-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-white transition-colors"
            title="효과음 켜기/끄기"
          >
            {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4 text-cyan-400" />}
          </button>

          {/* Open QR / Connect Modal Button */}
          <button
            onClick={() => setIsQrModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs transition-colors shadow-[0_0_15px_rgba(6,182,212,0.3)]"
          >
            <QrCode className="w-4 h-4" />
            <span>QR 코드 크게 보기</span>
          </button>
        </div>
      </header>

      {/* Main Game Screen Canvas */}
      <div className="relative flex-1 bg-slate-950 overflow-hidden">
        <canvas ref={canvasRef} className="w-full h-full block" />

        {/* Floating Mini QR Panel on Bottom Right */}
        <div className="absolute bottom-5 right-5 z-20 w-72 bg-slate-900/90 backdrop-blur-md border border-slate-800 rounded-2xl p-4 shadow-2xl flex flex-col gap-3">
          <div className="flex items-center justify-between pb-2 border-b border-slate-800/80">
            <div className="flex items-center gap-1.5">
              <QrCode className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-bold text-slate-200">핸드폰으로 접속하기</span>
            </div>
            {controllerConnected ? (
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                연결 성공
              </span>
            ) : (
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse">
                대기 중
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <div className="p-2 bg-white rounded-xl shadow-md shrink-0">
              <QRCodeSVG value={controllerUrl} size={88} level="M" />
            </div>
            <div className="flex flex-col justify-between text-xs text-slate-400">
              <p className="leading-snug">
                핸드폰 기본 카메라 앱으로 QR 코드를 비추면 조이스틱 화면이 열립니다.
              </p>
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  onClick={handleCopyLink}
                  className="flex items-center gap-1 text-[11px] font-mono text-cyan-400 hover:text-cyan-300 transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? '복사완료' : '링크 복사'}</span>
                </button>
                <span className="text-slate-600">•</span>
                <a
                  href={controllerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-[11px] font-mono text-slate-300 hover:text-white transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>새 탭 열기</span>
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Floating Telemetry & Mode Selector Bar (Top Left) */}
        <div className="absolute top-5 left-5 z-20 flex flex-col gap-3">
          {/* Game Mode Pills */}
          <div className="flex items-center gap-1.5 p-1 bg-slate-900/85 backdrop-blur-md border border-slate-800 rounded-xl shadow-lg">
            <button
              onClick={() => setGameMode('hovercraft')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                gameMode === 'hovercraft'
                  ? 'bg-cyan-500 text-slate-950 shadow-[0_0_12px_rgba(6,182,212,0.4)]'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Rocket className="w-3.5 h-3.5" />
              <span>호버크래프트</span>
            </button>

            <button
              onClick={() => setGameMode('drone')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                gameMode === 'drone'
                  ? 'bg-cyan-500 text-slate-950 shadow-[0_0_12px_rgba(6,182,212,0.4)]'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Plane className="w-3.5 h-3.5" />
              <span>드론 비행</span>
            </button>

            <button
              onClick={() => setGameMode('diagnostics')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                gameMode === 'diagnostics'
                  ? 'bg-cyan-500 text-slate-950 shadow-[0_0_12px_rgba(6,182,212,0.4)]'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>조이스틱 계측실</span>
            </button>
          </div>

          {/* Live Telemetry Display */}
          <div className="w-64 bg-slate-900/85 backdrop-blur-md border border-slate-800 rounded-xl p-3.5 shadow-lg flex flex-col gap-2 font-mono text-xs">
            <div className="flex items-center justify-between text-slate-400 pb-1.5 border-b border-slate-800">
              <span className="text-[11px] font-bold text-slate-300">실시간 조이스틱 수신 상태</span>
              <span className="text-[10px] text-cyan-400">패킷 {packetCount}</span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="bg-slate-950/60 p-1.5 rounded border border-slate-800/80">
                <div className="text-slate-500 text-[10px]">X 축</div>
                <div className="text-cyan-400 font-semibold">{latestInput.x.toFixed(2)}</div>
              </div>
              <div className="bg-slate-950/60 p-1.5 rounded border border-slate-800/80">
                <div className="text-slate-500 text-[10px]">Y 축</div>
                <div className="text-cyan-400 font-semibold">{latestInput.y.toFixed(2)}</div>
              </div>
              <div className="bg-slate-950/60 p-1.5 rounded border border-slate-800/80">
                <div className="text-slate-500 text-[10px]">각도 (ANGLE)</div>
                <div className="text-emerald-400 font-semibold">{latestInput.angle}°</div>
              </div>
              <div className="bg-slate-950/60 p-1.5 rounded border border-slate-800/80">
                <div className="text-slate-500 text-[10px]">추진력 (PWR)</div>
                <div className="text-amber-400 font-semibold">{Math.round(latestInput.distance * 100)}%</div>
              </div>
            </div>

            {/* Buttons Status Indicators */}
            <div className="flex items-center justify-between pt-1">
              <span className={`px-2 py-0.5 rounded text-[10px] border ${
                latestButtons.boost
                  ? 'bg-orange-500/20 border-orange-500 text-orange-300 font-bold'
                  : 'bg-slate-950/40 border-slate-800 text-slate-600'
              }`}>
                NITRO
              </span>
              <span className={`px-2 py-0.5 rounded text-[10px] border ${
                latestButtons.action
                  ? 'bg-rose-500/20 border-rose-500 text-rose-300 font-bold'
                  : 'bg-slate-950/40 border-slate-800 text-slate-600'
              }`}>
                FIRE
              </span>
              <span className={`px-2 py-0.5 rounded text-[10px] border ${
                latestButtons.jump
                  ? 'bg-violet-500/20 border-violet-500 text-violet-300 font-bold'
                  : 'bg-slate-950/40 border-slate-800 text-slate-600'
              }`}>
                JUMP
              </span>
              <span className={`px-2 py-0.5 rounded text-[10px] border ${
                latestButtons.light
                  ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300 font-bold'
                  : 'bg-slate-950/40 border-slate-800 text-slate-600'
              }`}>
                LIGHT
              </span>
            </div>
          </div>
        </div>

        {/* Diagnostics Overlay when Diagnostics Mode is Selected */}
        {gameMode === 'diagnostics' && (
          <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center">
            <div className="bg-slate-900/90 backdrop-blur-xl border border-cyan-500/40 rounded-3xl p-8 max-w-xl w-full mx-4 shadow-2xl flex flex-col items-center gap-6 pointer-events-auto">
              <div className="text-center">
                <h3 className="text-xl font-bold text-white mb-1">조이스틱 신호 정밀 계측실</h3>
                <p className="text-xs text-slate-400">핸드폰 조이스틱을 움직여 2D 극좌표계 벡터와 실시간 압력을 확인하세요</p>
              </div>

              {/* Vector Oscilloscope Visualizer */}
              <div className="relative w-56 h-56 rounded-full border-2 border-dashed border-cyan-500/40 flex items-center justify-center bg-slate-950/80">
                <div className="absolute inset-x-0 top-1/2 h-[1px] bg-slate-800" />
                <div className="absolute inset-y-0 left-1/2 w-[1px] bg-slate-800" />
                <div className="absolute inset-10 rounded-full border border-slate-800/80" />

                {/* Center origin */}
                <div className="w-2 h-2 rounded-full bg-slate-600" />

                {/* Target Vector Puck */}
                <div
                  className="absolute w-7 h-7 rounded-full bg-cyan-400 shadow-[0_0_20px_rgba(6,182,212,1)] ring-2 ring-white flex items-center justify-center transition-all duration-75"
                  style={{
                    transform: `translate(${latestInput.x * 90}px, ${latestInput.y * 90}px)`,
                  }}
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-slate-950" />
                </div>
              </div>

              <div className="grid grid-cols-4 gap-3 w-full text-center font-mono">
                <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800">
                  <div className="text-slate-500 text-[10px]">X VECTOR</div>
                  <div className="text-cyan-400 text-sm font-bold">{latestInput.x}</div>
                </div>
                <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800">
                  <div className="text-slate-500 text-[10px]">Y VECTOR</div>
                  <div className="text-cyan-400 text-sm font-bold">{latestInput.y}</div>
                </div>
                <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800">
                  <div className="text-slate-500 text-[10px]">ANGLE</div>
                  <div className="text-emerald-400 text-sm font-bold">{latestInput.angle}°</div>
                </div>
                <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800">
                  <div className="text-slate-500 text-[10px]">FORCE</div>
                  <div className="text-amber-400 text-sm font-bold">{Math.round(latestInput.distance * 100)}%</div>
                </div>
              </div>

              <button
                onClick={() => setGameMode('hovercraft')}
                className="px-5 py-2 rounded-xl bg-cyan-500 text-slate-950 font-bold text-xs hover:bg-cyan-400 transition-colors"
              >
                호버크래프트 플레이 모드로 복귀
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Large QR Code Modal */}
      {isQrModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 max-w-sm w-full shadow-2xl flex flex-col items-center gap-4 text-center">
            <h3 className="text-lg font-bold text-white">핸드폰으로 스캔하세요</h3>
            <p className="text-xs text-slate-400">
              스마트폰 카메라로 아래 QR 코드를 비추면 즉시 조이스틱 컨트롤러가 실행됩니다.
            </p>

            <div className="p-4 bg-white rounded-2xl shadow-xl">
              <QRCodeSVG value={controllerUrl} size={210} level="H" />
            </div>

            <div className="w-full bg-slate-950/80 p-2.5 rounded-xl border border-slate-800 font-mono text-[11px] text-cyan-400 break-all select-all">
              {controllerUrl}
            </div>

            <div className="flex items-center gap-2 w-full">
              <button
                onClick={handleCopyLink}
                className="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 transition-colors flex items-center justify-center gap-1.5"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                <span>{copied ? '복사완료' : 'URL 복사'}</span>
              </button>

              <button
                onClick={() => setIsQrModalOpen(false)}
                className="flex-1 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-xs font-bold text-slate-950 transition-colors"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
