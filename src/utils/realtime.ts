import { Peer, DataConnection } from 'peerjs';

export type MessageHandler = (data: any) => void;

interface RealtimeConfig {
  roomId: string;
  role: 'host' | 'controller';
  name?: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onMessage?: MessageHandler;
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected', info?: string) => void;
}

export class RealtimeChannel {
  private config: RealtimeConfig;
  private peer: Peer | null = null;
  private ws: WebSocket | null = null;
  private connections: Map<string, DataConnection> = new Map();
  private isDestroyed = false;
  private pingInterval: any = null;
  private usingWs = false;

  constructor(config: RealtimeConfig) {
    this.config = config;
    this.init();
  }

  private sanitizePeerId(roomId: string, role: string, suffix?: string): string {
    const cleanRoom = roomId.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (role === 'host') {
      return `qrjoy-host-${cleanRoom}`;
    }
    const rand = suffix || Math.random().toString(36).substring(2, 7);
    return `qrjoy-ctrl-${cleanRoom}-${rand}`;
  }

  private async init() {
    if (this.isDestroyed) return;
    this.config.onStatusChange?.('connecting', '연결 시도 중...');

    // First check if a local / custom WebSocket server exists (e.g. running on Cloud Run or localhost)
    const isLocalOrNode = 
      window.location.hostname === 'localhost' || 
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname.includes('.run.app');

    if (isLocalOrNode) {
      this.tryWebSocket();
    }

    // Always start WebRTC PeerJS so it works everywhere, especially on GitHub Pages (static)!
    this.startPeerJS();
  }

  private tryWebSocket() {
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws?roomId=${encodeURIComponent(this.config.roomId)}&role=${this.config.role}`;
      const socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        if (this.isDestroyed) {
          socket.close();
          return;
        }
        this.ws = socket;
        this.usingWs = true;
        this.config.onStatusChange?.('connected', '서버 연결 완료 (WS)');
        this.config.onConnect?.();

        socket.send(JSON.stringify({
          type: 'join',
          roomId: this.config.roomId,
          role: this.config.role,
          name: this.config.name,
        }));
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.config.onMessage?.(data);
        } catch {
          // ignore
        }
      };

      socket.onclose = () => {
        this.usingWs = false;
        this.ws = null;
      };

      socket.onerror = () => {
        // Fallback silently to PeerJS on GitHub Pages
        this.usingWs = false;
      };
    } catch {
      // WS not available (GitHub Pages static host)
    }
  }

  private startPeerJS() {
    try {
      const isHost = this.config.role === 'host';
      const myPeerId = this.sanitizePeerId(this.config.roomId, this.config.role);
      const targetHostId = this.sanitizePeerId(this.config.roomId, 'host');

      const peer = new Peer(myPeerId, {
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' },
          ],
        },
      });

      this.peer = peer;

      peer.on('open', (id) => {
        if (this.isDestroyed) return;

        if (isHost) {
          this.config.onStatusChange?.('connected', '호스트 대기 중 (WebRTC)');
        } else {
          // Controller connects to host peer
          this.config.onStatusChange?.('connecting', '호스트 연결 중...');
          this.connectToHost(targetHostId);
        }
      });

      // Handle incoming connections (host side)
      peer.on('connection', (conn) => {
        this.setupConnection(conn);
      });

      peer.on('error', (err: any) => {
        // If host ID is already taken (e.g. quick refresh), retry with random ID or re-connect
        if (err.type === 'unavailable-id' && isHost) {
          setTimeout(() => {
            if (!this.isDestroyed) {
              this.peer?.destroy();
              this.startPeerJS();
            }
          }, 1500);
        } else if (!isHost && err.type === 'peer-unavailable') {
          // Host not ready yet, retry in 2 seconds
          setTimeout(() => {
            if (!this.isDestroyed) {
              this.connectToHost(targetHostId);
            }
          }, 2000);
        }
      });
    } catch (err) {
      console.warn('PeerJS init warning:', err);
    }
  }

  private connectToHost(targetHostId: string) {
    if (!this.peer || this.peer.destroyed) return;
    try {
      const conn = this.peer.connect(targetHostId, { reliable: true });
      this.setupConnection(conn);
    } catch (err) {
      console.warn('Connect to host error:', err);
    }
  }

  private setupConnection(conn: DataConnection) {
    conn.on('open', () => {
      if (this.isDestroyed) {
        conn.close();
        return;
      }
      this.connections.set(conn.peer, conn);
      this.config.onStatusChange?.('connected', 'P2P 연결 완료');
      this.config.onConnect?.();

      // Notify peer
      if (this.config.role === 'controller') {
        conn.send({
          type: 'peer_joined',
          role: 'controller',
          name: this.config.name || '모바일 조이스틱',
        });
      }
    });

    conn.on('data', (data) => {
      this.config.onMessage?.(data);
    });

    conn.on('close', () => {
      this.connections.delete(conn.peer);
      if (this.connections.size === 0 && !this.usingWs) {
        this.config.onDisconnect?.();
        this.config.onStatusChange?.('disconnected', '연결 끊김');
      }
    });

    conn.on('error', () => {
      this.connections.delete(conn.peer);
    });
  }

  public send(data: any) {
    // 1. Send via WebSocket if active
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }

    // 2. Send via WebRTC DataConnection
    for (const conn of this.connections.values()) {
      if (conn.open) {
        conn.send(data);
      }
    }
  }

  public destroy() {
    this.isDestroyed = true;
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
  }
}
