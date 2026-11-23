/**
 * P2P Network Module
 *
 * Real multi-transport peer-to-peer network layer:
 * 1. BroadcastChannel Mesh: Zero-server direct P2P across tabs/windows on the same device.
 * 2. WebRTC DataChannels (RTCPeerConnection): Direct browser-to-browser / device-to-device P2P.
 * 3. Voluntary WebSocket Rendezvous & Relay (/ws/p2p): Stateless signaling & fallback relay
 *    when symmetric NAT prevents direct WebRTC ICE connectivity.
 *
 * Supports immediate master Kill Switch (networkEnabled = false) and real RTT telemetry.
 */

import { bytesToHex, randomBytes, signEd25519 } from '../crypto/CryptoModule';
import type { SecurityModule } from '../security/SecurityModule';
import type {
  IdentityPublicCard,
  LocalIdentitySecret,
  NodeSettings,
  PeerCapabilities,
  PeerInfo,
  WireEnvelope,
} from '../types';

type EnvelopeHandler = (envelope: WireEnvelope, viaPeerId: string) => void;
type PeerChangeHandler = () => void;

interface RtcSignalPayload {
  kind: 'offer' | 'answer' | 'ice';
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

const BROADCAST_CHANNEL_NAME = 'mix-p2p-mesh-v1';

export function normalizeRelayEndpoint(raw: string): string {
  const value = raw.trim();
  if (!value) return '';

  if (/^https?:\/\//i.test(value)) {
    const converted = value.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
    try {
      const parsed = new URL(converted);
      if (!parsed.pathname || parsed.pathname === '/') {
        parsed.pathname = '/ws/p2p';
      }
      return parsed.toString();
    } catch {
      return converted;
    }
  }

  if (/^wss?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (!parsed.pathname || parsed.pathname === '/') {
        parsed.pathname = '/ws/p2p';
      }
      return parsed.toString();
    } catch {
      return value;
    }
  }

  // Plain IP / host like "192.168.1.15" or "192.168.1.15:39140"
  const hasPort = /:\d+($|\/)/.test(value);
  const hostPart = value.replace(/\/+$/, '');
  return `ws://${hasPort ? hostPart : `${hostPart}:39140`}/ws/p2p`;
}

export class P2PNetworkModule {
  private peers = new Map<string, PeerInfo>();
  private rtcConnections = new Map<string, RTCPeerConnection>();
  private dataChannels = new Map<string, RTCDataChannel>();
  private bc: BroadcastChannel | null = null;
  private ws: WebSocket | null = null;
  private wsConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingPings = new Map<string, number>();

  private mySecret: LocalIdentitySecret | null = null;
  private myCard: IdentityPublicCard | null = null;
  private totalBytesSent = 0;
  private totalBytesReceived = 0;
  private batteryLevel: number | null = null;
  private charging: boolean | null = null;

  private envelopeHandlers: EnvelopeHandler[] = [];
  private peerChangeHandlers: PeerChangeHandler[] = [];

  constructor(
    public readonly myPeerId: string,
    private security: SecurityModule,
    private getSettings: () => NodeSettings,
    private getStorageStats: () => Promise<{ usedBytes: number }>
  ) {
    this.initBatteryMonitor();
  }

  private initBatteryMonitor(): void {
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<{
        level: number;
        charging: boolean;
        addEventListener: (ev: string, cb: () => void) => void;
      }>;
    };
    if (typeof nav.getBattery === 'function') {
      nav
        .getBattery()
        .then((batt) => {
          this.batteryLevel = batt.level;
          this.charging = batt.charging;
          batt.addEventListener('levelchange', () => {
            this.batteryLevel = batt.level;
          });
          batt.addEventListener('chargingchange', () => {
            this.charging = batt.charging;
          });
        })
        .catch(() => {
          // Battery API unavailable on desktop Safari/Firefox
        });
    }
  }

  onEnvelope(handler: EnvelopeHandler): () => void {
    this.envelopeHandlers.push(handler);
    return () => {
      this.envelopeHandlers = this.envelopeHandlers.filter((h) => h !== handler);
    };
  }

  onPeersChanged(handler: PeerChangeHandler): () => void {
    this.peerChangeHandlers.push(handler);
    return () => {
      this.peerChangeHandlers = this.peerChangeHandlers.filter((h) => h !== handler);
    };
  }

  private notifyPeersChanged(): void {
    for (const h of this.peerChangeHandlers) h();
  }

  getBatteryState(): { batteryLevel: number | null; charging: boolean | null } {
    return { batteryLevel: this.batteryLevel, charging: this.charging };
  }

  isRelayConnected(): boolean {
    return this.wsConnected;
  }

  getTrafficStats(): { totalBytesSent: number; totalBytesReceived: number } {
    return {
      totalBytesSent: this.totalBytesSent,
      totalBytesReceived: this.totalBytesReceived,
    };
  }

  getConnectedPeers(): PeerInfo[] {
    return Array.from(this.peers.values()).filter((p) => p.connected);
  }

  getAllKnownPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  getPeerByDid(did: string): PeerInfo | undefined {
    for (const p of this.peers.values()) {
      if (p.did === did && p.connected) return p;
    }
    return undefined;
  }

  getPeer(peerId: string): PeerInfo | undefined {
    return this.peers.get(peerId);
  }

  async getMyCapabilities(): Promise<PeerCapabilities> {
    const settings = this.getSettings();
    const stats = await this.getStorageStats();
    const free = Math.max(0, settings.maxStorageBytes - stats.usedBytes);
    return {
      freeStorageBytes: settings.storageNodeActive ? free : 0,
      maxStorageBytes: settings.maxStorageBytes,
      usedStorageBytes: stats.usedBytes,
      alwaysOnNode: settings.alwaysOnStorageNode,
      batteryLevel: this.batteryLevel,
      charging: this.charging,
      bandwidthBudgetMbps: settings.maxUploadBandwidthMbps,
      regionHint: settings.shareGeoHint
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : undefined,
    };
  }

  async start(secret: LocalIdentitySecret, card: IdentityPublicCard): Promise<void> {
    this.mySecret = secret;
    this.myCard = card;

    const settings = this.getSettings();
    if (!settings.networkEnabled) {
      this.stop();
      return;
    }

    if (settings.enableBroadcastChannel && typeof BroadcastChannel !== 'undefined') {
      this.startBroadcastChannel();
    }

    if (settings.enableVoluntaryRelay || settings.enableWebRTC) {
      this.connectRendezvousSocket();
    }

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeatAndPings().catch(() => {});
    }, 5000);

    await this.announceSelf();
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.bc) {
      this.bc.close();
      this.bc = null;
    }
    for (const dc of this.dataChannels.values()) {
      try {
        dc.close();
      } catch {
        // ignore
      }
    }
    this.dataChannels.clear();
    for (const pc of this.rtcConnections.values()) {
      try {
        pc.close();
      } catch {
        // ignore
      }
    }
    this.rtcConnections.clear();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.wsConnected = false;

    for (const peer of this.peers.values()) {
      peer.connected = false;
    }
    this.notifyPeersChanged();
  }

  async restart(): Promise<void> {
    this.stop();
    if (this.mySecret && this.myCard && this.getSettings().networkEnabled) {
      await this.start(this.mySecret, this.myCard);
    }
  }

  private startBroadcastChannel(): void {
    if (this.bc) return;
    this.bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    this.bc.onmessage = (ev: MessageEvent) => {
      const data = ev.data as WireEnvelope;
      if (!data || data.fromPeerId === this.myPeerId) return;
      if (data.targetPeerId && data.targetPeerId !== this.myPeerId) return;
      this.handleIncomingWireEnvelope(data, 'broadcast');
    };
  }

  private resolveRelayWsUrl(): string | null {
    const custom = normalizeRelayEndpoint(this.getSettings().relayEndpoint);
    if (custom) return custom;

    const envDefaultRaw = (
      import.meta as unknown as { env?: Record<string, string | undefined> }
    ).env?.VITE_DEFAULT_RELAY_URL;
    const envDefault = envDefaultRaw ? normalizeRelayEndpoint(envDefaultRaw) : '';
    if (envDefault) return envDefault;

    const isCapacitorShell =
      window.location.protocol === 'capacitor:' ||
      (window.location.protocol === 'https:' &&
        window.location.hostname === 'localhost' &&
        !window.location.port);
    if (isCapacitorShell) {
      return null;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws/p2p`;
  }

  private connectRendezvousSocket(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      const url = this.resolveRelayWsUrl();
      if (!url) {
        this.wsConnected = false;
        return;
      }
      const socket = new WebSocket(url);
      this.ws = socket;

      socket.onopen = () => {
        this.wsConnected = true;
        socket.send(
          JSON.stringify({
            type: 'peer:register',
            fromPeerId: this.myPeerId,
          })
        );
        this.announceSelf().catch(() => {});
        this.notifyPeersChanged();
      };

      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as {
            type: string;
            fromPeerId?: string;
            payload?: unknown;
          };
          if (msg.type === 'peer:list') {
            const list = (msg.payload as { peers?: string[] })?.peers || [];
            this.handleRendezvousPeerList(list);
          } else if (msg.type === 'rtc:signal' && msg.fromPeerId) {
            this.handleRtcSignal(msg.fromPeerId, msg.payload as RtcSignalPayload).catch(() => {});
          } else if (msg.type === 'p2p:packet' && msg.payload) {
            const env = msg.payload as WireEnvelope;
            if (env.fromPeerId !== this.myPeerId) {
              this.handleIncomingWireEnvelope(env, 'relay');
            }
          }
        } catch {
          // ignore malformed frame
        }
      };

      socket.onclose = () => {
        this.wsConnected = false;
        this.notifyPeersChanged();
        if (this.getSettings().networkEnabled) {
          this.reconnectTimer = setTimeout(() => {
            this.connectRendezvousSocket();
          }, 3000);
        }
      };

      socket.onerror = () => {
        this.wsConnected = false;
      };
    } catch {
      this.wsConnected = false;
    }
  }

  private handleRendezvousPeerList(peerIds: string[]): void {
    const activeSet = new Set(peerIds);
    for (const [pid, info] of this.peers.entries()) {
      if (pid !== this.myPeerId && !activeSet.has(pid) && info.transport !== 'broadcast') {
        const dc = this.dataChannels.get(pid);
        if (!dc || dc.readyState !== 'open') {
          info.connected = false;
        }
      }
    }

    for (const pid of peerIds) {
      if (pid === this.myPeerId || this.security.isPeerBlocked(pid)) continue;
      if (!this.peers.has(pid)) {
        this.peers.set(pid, {
          peerId: pid,
          transport: 'relay',
          connected: true,
          rttMs: null,
          connectedAt: Date.now(),
          lastSeen: Date.now(),
          reputation: this.security.getReputation(pid),
          capabilities: {
            freeStorageBytes: 0,
            maxStorageBytes: 0,
            usedStorageBytes: 0,
            alwaysOnNode: false,
            batteryLevel: null,
            charging: null,
            bandwidthBudgetMbps: 10,
          },
          bytesSent: 0,
          bytesReceived: 0,
        });
      } else {
        const p = this.peers.get(pid)!;
        p.connected = true;
        p.lastSeen = Date.now();
      }

      // Deterministic WebRTC initiator rule: lexicographically smaller PeerID initiates offer
      if (
        this.getSettings().enableWebRTC &&
        this.myPeerId < pid &&
        !this.rtcConnections.has(pid)
      ) {
        this.initiateWebRTC(pid).catch(() => {});
      }
    }

    this.announceSelf().catch(() => {});
    this.notifyPeersChanged();
  }

  private createPeerConnection(remotePeerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'rtc:signal',
            fromPeerId: this.myPeerId,
            targetPeerId: remotePeerId,
            payload: { kind: 'ice', candidate: ev.candidate.toJSON() } satisfies RtcSignalPayload,
          })
        );
      }
    };

    pc.ondatachannel = (ev) => {
      this.wireDataChannel(remotePeerId, ev.channel);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.dataChannels.delete(remotePeerId);
        this.rtcConnections.delete(remotePeerId);
        const info = this.peers.get(remotePeerId);
        if (info && info.transport === 'webrtc') {
          info.transport = this.wsConnected ? 'relay' : 'broadcast';
        }
        this.notifyPeersChanged();
      }
    };

    this.rtcConnections.set(remotePeerId, pc);
    return pc;
  }

  private wireDataChannel(remotePeerId: string, dc: RTCDataChannel): void {
    dc.onopen = () => {
      this.dataChannels.set(remotePeerId, dc);
      const info = this.peers.get(remotePeerId);
      if (info) {
        info.transport = 'webrtc';
        info.connected = true;
        info.lastSeen = Date.now();
      }
      this.announceSelf(remotePeerId).catch(() => {});
      this.notifyPeersChanged();
    };

    dc.onmessage = (ev) => {
      try {
        const env = JSON.parse(String(ev.data)) as WireEnvelope;
        if (env.fromPeerId !== this.myPeerId) {
          this.handleIncomingWireEnvelope(env, 'webrtc');
        }
      } catch {
        // ignore invalid JSON
      }
    };

    dc.onclose = () => {
      this.dataChannels.delete(remotePeerId);
      const info = this.peers.get(remotePeerId);
      if (info && info.transport === 'webrtc') {
        info.transport = this.wsConnected ? 'relay' : 'broadcast';
      }
      this.notifyPeersChanged();
    };
  }

  private async initiateWebRTC(remotePeerId: string): Promise<void> {
    if (typeof RTCPeerConnection === 'undefined') return;
    const pc = this.createPeerConnection(remotePeerId);
    const dc = pc.createDataChannel('mix-p2p', { ordered: true });
    this.wireDataChannel(remotePeerId, dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'rtc:signal',
          fromPeerId: this.myPeerId,
          targetPeerId: remotePeerId,
          payload: { kind: 'offer', sdp: pc.localDescription ?? offer } satisfies RtcSignalPayload,
        })
      );
    }
  }

  private async handleRtcSignal(remotePeerId: string, signal: RtcSignalPayload): Promise<void> {
    if (!this.getSettings().enableWebRTC || typeof RTCPeerConnection === 'undefined') return;
    let pc = this.rtcConnections.get(remotePeerId);

    if (signal.kind === 'offer' && signal.sdp) {
      if (!pc) pc = this.createPeerConnection(remotePeerId);
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'rtc:signal',
            fromPeerId: this.myPeerId,
            targetPeerId: remotePeerId,
            payload: { kind: 'answer', sdp: pc.localDescription ?? answer } satisfies RtcSignalPayload,
          })
        );
      }
    } else if (signal.kind === 'answer' && signal.sdp && pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    } else if (signal.kind === 'ice' && signal.candidate && pc) {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  }

  createEnvelope(
    type: WireEnvelope['type'],
    payload: unknown,
    targetPeerId?: string,
    targetDid?: string,
    sign = true
  ): WireEnvelope {
    const env: WireEnvelope = {
      id: `env-${Date.now()}-${bytesToHex(randomBytes(6))}`,
      type,
      fromPeerId: this.myPeerId,
      fromDid: this.mySecret?.did,
      targetPeerId,
      targetDid,
      timestamp: Date.now(),
      nonce: bytesToHex(randomBytes(12)),
      payload,
    };

    if (sign && this.mySecret) {
      const canonical = JSON.stringify({
        id: env.id,
        type: env.type,
        fromPeerId: env.fromPeerId,
        fromDid: env.fromDid,
        targetPeerId: env.targetPeerId,
        targetDid: env.targetDid,
        timestamp: env.timestamp,
        nonce: env.nonce,
        payload: env.payload,
      });
      env.signature = signEd25519(canonical, this.mySecret.ed25519PrivateKey);
    }

    return env;
  }

  async announceSelf(targetPeerId?: string): Promise<void> {
    if (!this.myCard || !this.getSettings().networkEnabled) return;
    const capabilities = await this.getMyCapabilities();
    const env = this.createEnvelope(
      'PEER_HELLO',
      { card: this.myCard, capabilities },
      targetPeerId
    );
    this.sendEnvelope(env, targetPeerId);
  }

  private async sendHeartbeatAndPings(): Promise<void> {
    if (!this.getSettings().networkEnabled) return;
    await this.announceSelf();

    const now = Date.now();
    for (const peer of this.peers.values()) {
      if (now - peer.lastSeen > 25000 && peer.transport === 'broadcast') {
        peer.connected = false;
      }
      if (peer.connected) {
        const pingEnv = this.createEnvelope('PING', { sentAt: now }, peer.peerId, undefined, false);
        this.pendingPings.set(pingEnv.id, now);
        this.sendEnvelope(pingEnv, peer.peerId);
      }
    }
  }

  sendEnvelope(envelope: WireEnvelope, targetPeerId?: string): boolean {
    const settings = this.getSettings();
    if (!settings.networkEnabled) return false;

    const json = JSON.stringify(envelope);
    const byteLen = json.length;
    let sent = false;

    if (targetPeerId) {
      const dc = this.dataChannels.get(targetPeerId);
      if (dc && dc.readyState === 'open') {
        dc.send(json);
        sent = true;
      } else if (settings.enableBroadcastChannel && this.bc) {
        // Try BroadcastChannel for local multi-tab peers
        const peer = this.peers.get(targetPeerId);
        if (!peer || peer.transport === 'broadcast') {
          this.bc.postMessage(envelope);
          sent = true;
        }
      }
      if (!sent && settings.enableVoluntaryRelay && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'p2p:packet',
            fromPeerId: this.myPeerId,
            targetPeerId,
            payload: envelope,
          })
        );
        sent = true;
      }

      if (sent) {
        this.totalBytesSent += byteLen;
        const p = this.peers.get(targetPeerId);
        if (p) p.bytesSent += byteLen;
      }
      return sent;
    }

    // Broadcast to all transports
    if (settings.enableBroadcastChannel && this.bc) {
      this.bc.postMessage(envelope);
      sent = true;
    }
    for (const [pid, dc] of this.dataChannels.entries()) {
      if (dc.readyState === 'open') {
        dc.send(json);
        const p = this.peers.get(pid);
        if (p) p.bytesSent += byteLen;
        sent = true;
      }
    }
    if (settings.enableVoluntaryRelay && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'p2p:packet',
          fromPeerId: this.myPeerId,
          payload: envelope,
        })
      );
      sent = true;
    }
    if (sent) this.totalBytesSent += byteLen;
    return sent;
  }

  private handleIncomingWireEnvelope(
    env: WireEnvelope,
    transport: PeerInfo['transport']
  ): void {
    if (!this.getSettings().networkEnabled) return;
    if (this.security.isPeerBlocked(env.fromPeerId, env.fromDid)) return;
    if (!this.security.checkRateLimit(env.fromPeerId)) return;
    if (!this.security.checkReplayNonce(env.nonce, env.timestamp)) return;

    const rawSize = JSON.stringify(env).length;
    this.totalBytesReceived += rawSize;

    const existing = this.peers.get(env.fromPeerId);
    const activeTransport: PeerInfo['transport'] =
      this.dataChannels.get(env.fromPeerId)?.readyState === 'open'
        ? 'webrtc'
        : existing?.transport === 'webrtc'
          ? 'webrtc'
          : transport;

    if (!existing) {
      this.peers.set(env.fromPeerId, {
        peerId: env.fromPeerId,
        did: env.fromDid,
        transport: activeTransport,
        connected: true,
        rttMs: null,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        reputation: this.security.getReputation(env.fromPeerId),
        capabilities: {
          freeStorageBytes: 0,
          maxStorageBytes: 0,
          usedStorageBytes: 0,
          alwaysOnNode: false,
          batteryLevel: null,
          charging: null,
          bandwidthBudgetMbps: 10,
        },
        bytesSent: 0,
        bytesReceived: rawSize,
      });
    } else {
      existing.connected = true;
      existing.transport = activeTransport;
      existing.lastSeen = Date.now();
      existing.bytesReceived += rawSize;
      existing.reputation = this.security.getReputation(env.fromPeerId);
    }

    if (env.type === 'PEER_HELLO') {
      const data = env.payload as { card?: IdentityPublicCard; capabilities?: PeerCapabilities };
      if (data.card && this.security.verifyIdentityAnnouncement(data.card)) {
        const peer = this.peers.get(env.fromPeerId)!;
        peer.did = data.card.did;
        peer.login = data.card.login;
        peer.ed25519PublicKey = data.card.ed25519PublicKey;
        peer.x25519PublicKey = data.card.x25519PublicKey;
        if (data.capabilities) peer.capabilities = data.capabilities;
        this.notifyPeersChanged();
      }
    } else if (env.type === 'PING') {
      const pong = this.createEnvelope(
        'PONG',
        { pingId: env.id },
        env.fromPeerId,
        undefined,
        false
      );
      this.sendEnvelope(pong, env.fromPeerId);
      return;
    } else if (env.type === 'PONG') {
      const pingId = (env.payload as { pingId?: string })?.pingId;
      if (pingId && this.pendingPings.has(pingId)) {
        const sentAt = this.pendingPings.get(pingId)!;
        this.pendingPings.delete(pingId);
        const peer = this.peers.get(env.fromPeerId);
        if (peer) {
          peer.rttMs = Math.max(1, Date.now() - sentAt);
          this.notifyPeersChanged();
        }
      }
      return;
    }

    for (const handler of this.envelopeHandlers) {
      handler(env, env.fromPeerId);
    }
  }
}
