/**
 * MiX Voluntary P2P Bootstrap & Circuit Relay Node (Stateless)
 *
 * IMPORTANT ARCHITECTURAL GUARANTEE:
 * - Zero database. Zero persistent storage. Zero user accounts.
 * - Stores NO messages, NO files, NO encryption keys, NO IP logs.
 * - Acts purely as a voluntary WebRTC signaling rendezvous and fallback
 *   circuit relay for NAT-restricted browsers.
 * - Same-browser multi-tab communication works even if this relay is offline
 *   via BroadcastChannel + established WebRTC DataChannels.
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

interface EphemeralPeer {
  peerId: string;
  socket: WebSocket;
  connectedAt: number;
  lastSeen: number;
}

interface RelayFrame {
  type: 'peer:register' | 'peer:list' | 'rtc:signal' | 'p2p:packet' | 'relay:ping';
  fromPeerId?: string;
  targetPeerId?: string;
  payload?: unknown;
}

const activePeers = new Map<string, EphemeralPeer>();
const startedAt = Date.now();

function isValidPeerId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9:_-]{8,128}$/.test(id);
}

function safeSend(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastPeerList(): void {
  const peerIds = Array.from(activePeers.keys());
  const message = {
    type: 'peer:list',
    payload: { peers: peerIds },
  };
  for (const peer of activePeers.values()) {
    safeSend(peer.socket, message);
  }
}

async function startServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/node-status', (_req, res) => {
    res.json({
      role: 'voluntary-stateless-rendezvous-relay',
      persistentStorage: false,
      activeRendezvousPeers: activePeers.size,
      uptimeMs: Date.now() - startedAt,
    });
  });

  const server = http.createServer(app);

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        ws: { server },
        hmr: process.env.DISABLE_HMR !== 'true' ? { server } : false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024, // 2 MiB max frame for relayed encrypted blocks
  });

  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (url.pathname === '/ws/p2p') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      }
    } catch {
      socket.destroy();
    }
  });

  wss.on('connection', (socket: WebSocket) => {
    let registeredPeerId: string | null = null;

    socket.on('message', (raw: Buffer | string) => {
      let frame: RelayFrame;
      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        frame = JSON.parse(text) as RelayFrame;
      } catch {
        return;
      }

      if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
        return;
      }

      if (frame.type === 'relay:ping') {
        safeSend(socket, { type: 'relay:pong', payload: { ts: Date.now() } });
        return;
      }

      if (frame.type === 'peer:register') {
        if (!isValidPeerId(frame.fromPeerId)) return;
        registeredPeerId = frame.fromPeerId;
        activePeers.set(registeredPeerId, {
          peerId: registeredPeerId,
          socket,
          connectedAt: Date.now(),
          lastSeen: Date.now(),
        });
        broadcastPeerList();
        return;
      }

      if (!registeredPeerId) return;
      const sender = activePeers.get(registeredPeerId);
      if (sender) sender.lastSeen = Date.now();

      if (frame.type === 'rtc:signal') {
        if (!isValidPeerId(frame.targetPeerId)) return;
        const target = activePeers.get(frame.targetPeerId);
        if (target) {
          safeSend(target.socket, {
            type: 'rtc:signal',
            fromPeerId: registeredPeerId,
            targetPeerId: frame.targetPeerId,
            payload: frame.payload,
          });
        }
        return;
      }

      if (frame.type === 'p2p:packet') {
        if (frame.targetPeerId && isValidPeerId(frame.targetPeerId)) {
          const target = activePeers.get(frame.targetPeerId);
          if (target) {
            safeSend(target.socket, {
              type: 'p2p:packet',
              fromPeerId: registeredPeerId,
              targetPeerId: frame.targetPeerId,
              payload: frame.payload,
            });
          }
        } else {
          // Opaque gossip/broadcast to all other connected peers
          for (const [peerId, peer] of activePeers.entries()) {
            if (peerId !== registeredPeerId) {
              safeSend(peer.socket, {
                type: 'p2p:packet',
                fromPeerId: registeredPeerId,
                payload: frame.payload,
              });
            }
          }
        }
      }
    });

    socket.on('close', () => {
      if (registeredPeerId) {
        const current = activePeers.get(registeredPeerId);
        if (current?.socket === socket) {
          activePeers.delete(registeredPeerId);
          broadcastPeerList();
        }
      }
    });

    socket.on('error', () => {
      if (registeredPeerId) {
        const current = activePeers.get(registeredPeerId);
        if (current?.socket === socket) {
          activePeers.delete(registeredPeerId);
        }
      }
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[MiX] Stateless P2P Rendezvous & Vite server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start MiX server:', err);
  process.exit(1);
});
