import React, { useEffect, useState } from 'react';
import { Copy, Check, Power, Wifi, WifiOff } from 'lucide-react';
import type { MixNodeController } from '../MixNodeController';
import type { NodeSettings, NodeTelemetrySnapshot } from '../types';
import { normalizeRelayEndpoint } from '../p2p/P2PNetworkModule';
import { DownloadsPanel } from './DownloadsPanel';

interface NetworkViewProps {
  controller: MixNodeController;
  settings: NodeSettings;
  telemetry: NodeTelemetrySnapshot;
}

export const NetworkView: React.FC<NetworkViewProps> = ({
  controller,
  settings,
  telemetry,
}) => {
  const [relayEndpoint, setRelayEndpoint] = useState(settings.relayEndpoint);
  const [lanEndpoints, setLanEndpoints] = useState<string[]>([]);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/node-status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { lanWsEndpoints?: string[] } | null) => {
        if (!cancelled && data && Array.isArray(data.lanWsEndpoints)) {
          setLanEndpoints(data.lanWsEndpoints);
        }
      })
      .catch(() => {
        // Static hosting or standalone Capacitor shell without local backend
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopyEndpoint = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="space-y-6">
      {/* Master Network Kill Switch */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          {settings.networkEnabled ? (
            <Wifi className="w-5 h-5 text-teal-600 mt-0.5 shrink-0" />
          ) : (
            <WifiOff className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
          )}
          <div>
            <h2 className="text-base font-semibold">Сетевая активность P2P-узла</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Полное отключение всех соединений BroadcastChannel, WebRTC и добровольного ретранслятора по желанию пользователя
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() =>
            controller.updateSettings({ networkEnabled: !settings.networkEnabled })
          }
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 ${
            settings.networkEnabled
              ? 'bg-red-600 hover:bg-red-700 text-white'
              : 'bg-teal-700 hover:bg-teal-800 text-white'
          }`}
        >
          <Power className="w-3.5 h-3.5" />
          <span>{settings.networkEnabled ? 'Отключить сеть' : 'Включить сеть'}</span>
        </button>
      </section>

      {/* Transport Layers */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
        <h2 className="text-base font-semibold">Транспортные протоколы P2P</h2>

        <div className="space-y-4 text-sm">
          <label className="flex items-start justify-between gap-4 cursor-pointer">
            <div>
              <div className="font-medium">Локальная P2P-шина (BroadcastChannel)</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Прямое обнаружение и обмен данными между вкладками/окнами одного устройства вообще без сервера
              </div>
            </div>
            <input
              type="checkbox"
              checked={settings.enableBroadcastChannel}
              onChange={(e) =>
                controller.updateSettings({ enableBroadcastChannel: e.target.checked })
              }
              className="mt-1 rounded border-slate-300 text-teal-600"
            />
          </label>

          <label className="flex items-start justify-between gap-4 cursor-pointer border-t border-slate-200 dark:border-slate-800 pt-4">
            <div>
              <div className="font-medium">Прямые каналы WebRTC DataChannel</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Прямое P2P-соединение между разными браузерами и устройствами поверх ICE/STUN
              </div>
            </div>
            <input
              type="checkbox"
              checked={settings.enableWebRTC}
              onChange={(e) =>
                controller.updateSettings({ enableWebRTC: e.target.checked })
              }
              className="mt-1 rounded border-slate-300 text-teal-600"
            />
          </label>

          <label className="flex items-start justify-between gap-4 cursor-pointer border-t border-slate-200 dark:border-slate-800 pt-4">
            <div>
              <div className="font-medium">Добровольный узел рандеву и ретрансляции (Circuit Relay)</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Используется для обмена SDP/ICE и резервной передачи зашифрованных пакетов через симметричный NAT. Не хранит данные и аккаунты.
              </div>
            </div>
            <input
              type="checkbox"
              checked={settings.enableVoluntaryRelay}
              onChange={(e) =>
                controller.updateSettings({ enableVoluntaryRelay: e.target.checked })
              }
              className="mt-1 rounded border-slate-300 text-teal-600"
            />
          </label>
        </div>

        <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2">
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Адрес узла рандеву (можно ввести просто IP вашего ПК в Wi-Fi, например 192.168.1.15)
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={relayEndpoint}
              onChange={(e) => setRelayEndpoint(e.target.value)}
              placeholder="192.168.1.15 или wss://..."
              className="flex-1 px-3.5 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <button
              type="button"
              onClick={() => {
                const normalized = normalizeRelayEndpoint(relayEndpoint);
                setRelayEndpoint(normalized);
                controller.updateSettings({ relayEndpoint: normalized });
              }}
              className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium whitespace-nowrap"
            >
              Применить адрес
            </button>
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Состояние рандеву-сокета:{' '}
            <span className="font-medium text-slate-800 dark:text-slate-200">
              {telemetry.relayConnected ? 'Подключён' : 'Отключён (автономный режим)'}
            </span>
          </div>
        </div>
      </section>

      {/* Embedded Desktop LAN Relay Endpoints (shown on Desktop Electron node) */}
      {lanEndpoints.length > 0 && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3">
          <h2 className="text-sm font-semibold">Адреса вашего ПК в локальной сети (для подключения телефонов по Wi-Fi)</h2>
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            На этом компьютере автоматически запущен встроенный узел рандеву/ретрансляции. Скопируйте один из адресов ниже и вставьте его в раздел «Сеть P2P» на телефоне в одной Wi-Fi сети:
          </p>
          <div className="space-y-2">
            {lanEndpoints.map((ep) => (
              <div
                key={ep}
                className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800"
              >
                <code className="text-xs font-mono text-slate-800 dark:text-slate-200 truncate">
                  {ep}
                </code>
                <button
                  type="button"
                  onClick={() => handleCopyEndpoint(ep)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-300 dark:border-slate-700 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  {copiedUrl === ep ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-teal-600" />
                      <span>Скопировано</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Копировать</span>
                    </>
                  )}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* NAT & Mobile Network Limitations */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-2">
        <h2 className="text-sm font-semibold">Ограничения прямого P2P через NAT и мобильные сети</h2>
        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
          В мобильных сетях (CGNAT) и за строгими симметричными NAT прямое соединение WebRTC/QUIC без публичного порта может быть заблокировано оператором. В таких условиях MiX автоматически переключает маршрут на добровольные узлы-ретрансляторы (Circuit Relay), сохраняя сквозное шифрование E2EE: ретранслятор видит только зашифрованные конверты и никогда не имеет доступа к содержимому.
        </p>
      </section>

      <DownloadsPanel />
    </div>
  );
};
