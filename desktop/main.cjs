/**
 * MiX Desktop Entry Point (Electron + Embedded Stateless P2P Rendezvous/Relay)
 *
 * Automatically starts a local & LAN-accessible stateless P2P WebSocket relay
 * (/ws/p2p) alongside serving the built frontend over http://127.0.0.1:39140,
 * so the desktop computer acts as both messenger client and network relay node
 * with zero user configuration.
 */

const { app, BrowserWindow, shell } = require('electron');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const RELAY_PORT = Number(process.env.MIX_PORT || 39140);
let mainWindow = null;
let httpServer = null;

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

function isValidPeerId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9:_-]{8,128}$/.test(id);
}

function startEmbeddedNodeServer() {
  return new Promise((resolve, reject) => {
    const expressApp = express();
    expressApp.disable('x-powered-by');

    const activePeers = new Map();
    const startedAt = Date.now();

    function safeSend(ws, data) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    }

    function broadcastPeerList() {
      const peerIds = Array.from(activePeers.keys());
      const message = { type: 'peer:list', payload: { peers: peerIds } };
      for (const peer of activePeers.values()) {
        safeSend(peer.socket, message);
      }
    }

    expressApp.get('/api/node-status', (_req, res) => {
      res.json({
        role: 'desktop-embedded-rendezvous-relay',
        persistentStorage: false,
        activeRendezvousPeers: activePeers.size,
        uptimeMs: Date.now() - startedAt,
        lanWsEndpoints: getLanAddresses().map((ip) => `ws://${ip}:${RELAY_PORT}/ws/p2p`),
      });
    });

    const distDir = path.join(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
      expressApp.use(express.static(distDir));
      expressApp.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }

    const server = http.createServer(expressApp);
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 2 * 1024 * 1024,
    });

    server.on('upgrade', (request, socket, head) => {
      try {
        const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
        if (url.pathname === '/ws/p2p') {
          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
          });
        } else {
          socket.destroy();
        }
      } catch {
        socket.destroy();
      }
    });

    wss.on('connection', (socket) => {
      let registeredPeerId = null;

      socket.on('message', (raw) => {
        let frame;
        try {
          frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
        } catch {
          return;
        }
        if (!frame || typeof frame.type !== 'string') return;

        if (frame.type === 'relay:ping') {
          safeSend(socket, { type: 'relay:pong', payload: { ts: Date.now() } });
          return;
        }

        if (frame.type === 'peer:register') {
          if (!isValidPeerId(frame.fromPeerId)) return;
          registeredPeerId = frame.fromPeerId;
          activePeers.set(registeredPeerId, { socket, lastSeen: Date.now() });
          broadcastPeerList();
          return;
        }

        if (!registeredPeerId) return;

        if (frame.type === 'rtc:signal' && isValidPeerId(frame.targetPeerId)) {
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
            for (const [pid, peer] of activePeers.entries()) {
              if (pid !== registeredPeerId) {
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
          if (current && current.socket === socket) {
            activePeers.delete(registeredPeerId);
            broadcastPeerList();
          }
        }
      });
    });

    server.on('error', reject);
    server.listen(RELAY_PORT, '0.0.0.0', () => {
      httpServer = server;
      resolve();
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 380,
    minHeight: 600,
    title: 'MiX — Децентрализованный P2P-мессенджер',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${RELAY_PORT}/`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${RELAY_PORT}`)) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  await startEmbeddedNodeServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (httpServer) {
    httpServer.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
