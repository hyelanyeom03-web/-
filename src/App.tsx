/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { HostScreen } from './components/HostScreen';
import { MobileController } from './components/MobileController';

// Generate random friendly room ID
function generateRoomId(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const num = Math.floor(100 + Math.random() * 900);
  let prefix = '';
  for (let i = 0; i < 3; i++) {
    prefix += letters.charAt(Math.floor(Math.random() * letters.length));
  }
  return `${prefix}-${num}`;
}

export default function App() {
  const [mode, setMode] = useState<'host' | 'controller'>('host');
  const [roomId, setRoomId] = useState<string>('');

  useEffect(() => {
    // Check URL params
    const searchParams = new URLSearchParams(window.location.search);
    const hash = window.location.hash;

    const urlMode = searchParams.get('mode') || (hash.includes('controller') ? 'controller' : null);
    const urlRoom = searchParams.get('room') || searchParams.get('roomId');

    if (urlMode === 'controller') {
      setMode('controller');
    } else {
      setMode('host');
    }

    if (urlRoom) {
      setRoomId(urlRoom.toUpperCase());
    } else {
      // Create new room ID and update search param
      const newRoom = generateRoomId();
      setRoomId(newRoom);
      const url = new URL(window.location.href);
      url.searchParams.set('room', newRoom);
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  const switchToController = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('mode', 'controller');
    url.searchParams.set('room', roomId);
    window.history.pushState({}, '', url.toString());
    setMode('controller');
  };

  const switchToHost = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('mode');
    url.searchParams.set('room', roomId);
    window.history.pushState({}, '', url.toString());
    setMode('host');
  };

  if (!roomId) {
    return (
      <div className="w-full h-screen bg-slate-950 flex items-center justify-center text-slate-400 font-mono text-sm">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-400 mr-3" />
        초기화 중...
      </div>
    );
  }

  if (mode === 'controller') {
    return <MobileController roomId={roomId} onLeave={switchToHost} />;
  }

  return <HostScreen roomId={roomId} onSwitchToController={switchToController} />;
}
