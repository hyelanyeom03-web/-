import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;

interface ClientMeta {
  ws: WebSocket;
  id: string;
  roomId: string;
  role: 'host' | 'controller';
  name?: string;
  color?: string;
  isAlive: boolean;
}

const clients = new Map<WebSocket, ClientMeta>();
const rooms = new Map<string, Set<ClientMeta>>();

function getOrCreateRoom(roomId: string): Set<ClientMeta> {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Set<ClientMeta>();
    rooms.set(roomId, room);
  }
  return room;
}

function broadcastToRoom(roomId: string, message: object, excludeWs?: WebSocket, targetRole?: 'host' | 'controller') {
  const room = rooms.get(roomId);
  if (!room) return;
  const msgStr = JSON.stringify(message);
  for (const client of room) {
    if (client.ws !== excludeWs && client.ws.readyState === WebSocket.OPEN) {
      if (!targetRole || client.role === targetRole) {
        client.ws.send(msgStr);
      }
    }
  }
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // Health check endpoint
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      activeRooms: rooms.size,
      connectedClients: clients.size,
      timestamp: Date.now(),
    });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Keep-alive heartbeat interval every 25s
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const meta = clients.get(ws);
      if (!meta) return;
      if (!meta.isAlive) {
        ws.terminate();
        return;
      }
      meta.isAlive = false;
      ws.ping();
    });
  }, 25000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  wss.on('connection', (ws, req) => {
    // Parse query params if provided in URL
    const urlObj = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const queryRoom = urlObj.searchParams.get('roomId') || '';
    const queryRole = (urlObj.searchParams.get('role') as 'host' | 'controller') || 'controller';

    const clientId = 'c_' + Math.random().toString(36).substring(2, 9);
    const meta: ClientMeta = {
      ws,
      id: clientId,
      roomId: queryRoom,
      role: queryRole,
      isAlive: true,
    };
    clients.set(ws, meta);

    ws.on('pong', () => {
      meta.isAlive = true;
    });

    if (queryRoom) {
      const room = getOrCreateRoom(queryRoom);
      room.add(meta);
      // Notify host of new controller or notify controller of host presence
      broadcastToRoom(queryRoom, {
        type: 'peer_joined',
        peerId: meta.id,
        role: meta.role,
        totalInRoom: room.size,
      }, ws);
    }

    // Send welcome
    ws.send(JSON.stringify({
      type: 'welcome',
      clientId,
      roomId: meta.roomId,
      role: meta.role,
    }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        switch (msg.type) {
          case 'join': {
            const requestedRoom = (msg.roomId || '').trim();
            const requestedRole = msg.role === 'host' ? 'host' : 'controller';
            if (!requestedRoom) return;

            // Remove from old room if changed
            if (meta.roomId && meta.roomId !== requestedRoom) {
              const oldRoom = rooms.get(meta.roomId);
              if (oldRoom) {
                oldRoom.delete(meta);
                if (oldRoom.size === 0) rooms.delete(meta.roomId);
                else {
                  broadcastToRoom(meta.roomId, {
                    type: 'peer_left',
                    peerId: meta.id,
                    role: meta.role,
                    totalInRoom: oldRoom.size,
                  });
                }
              }
            }

            meta.roomId = requestedRoom;
            meta.role = requestedRole;
            meta.name = msg.name || (requestedRole === 'host' ? 'Host Display' : 'Mobile Controller');
            meta.color = msg.color || '#06b6d4';

            const room = getOrCreateRoom(requestedRoom);
            room.add(meta);

            // Confirm join
            ws.send(JSON.stringify({
              type: 'joined',
              roomId: requestedRoom,
              role: requestedRole,
              clientId: meta.id,
              totalInRoom: room.size,
            }));

            // Broadcast to peers in room
            broadcastToRoom(requestedRoom, {
              type: 'peer_joined',
              peerId: meta.id,
              role: meta.role,
              name: meta.name,
              color: meta.color,
              totalInRoom: room.size,
            }, ws);
            break;
          }

          case 'joystick_input':
          case 'input': {
            if (!meta.roomId) return;
            // Forward joystick telemetry from controller to host
            broadcastToRoom(meta.roomId, {
              type: 'controller_input',
              controllerId: meta.id,
              name: meta.name,
              color: meta.color,
              payload: msg.payload || msg,
              timestamp: Date.now(),
            }, ws, 'host');
            break;
          }

          case 'haptic_feedback':
          case 'screen_event': {
            if (!meta.roomId) return;
            // Host can send feedback (vibration pattern, sound cues, score) to controller
            broadcastToRoom(meta.roomId, {
              type: 'device_feedback',
              event: msg.event || 'vibrate',
              pattern: msg.pattern || [50],
              data: msg.data,
            }, ws, 'controller');
            break;
          }

          case 'ping': {
            ws.send(JSON.stringify({
              type: 'pong',
              t: msg.t || Date.now(),
              serverTime: Date.now(),
            }));
            break;
          }

          default:
            // Generic broadcast inside the room
            if (meta.roomId) {
              broadcastToRoom(meta.roomId, {
                ...msg,
                senderId: meta.id,
                senderRole: meta.role,
              }, ws);
            }
            break;
        }
      } catch (err) {
        console.error('Error handling WS message:', err);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      if (meta.roomId) {
        const room = rooms.get(meta.roomId);
        if (room) {
          room.delete(meta);
          if (room.size === 0) {
            rooms.delete(meta.roomId);
          } else {
            broadcastToRoom(meta.roomId, {
              type: 'peer_left',
              peerId: meta.id,
              role: meta.role,
              totalInRoom: room.size,
            });
          }
        }
      }
    });

    ws.on('error', (err) => {
      console.warn('WS client error:', err.message);
    });
  });

  if (!isProd) {
    // Vite middleware in dev
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Static files in prod
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
