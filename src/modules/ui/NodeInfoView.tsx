import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { MixNodeController } from '../MixNodeController';
import type { NodeTelemetrySnapshot } from '../types';
import { formatBytes, formatDateTime, shortHash } from './formatters';

interface NodeInfoViewProps {
  controller: MixNodeController;
  telemetry: NodeTelemetrySnapshot;
}

export const NodeInfoView: React.FC<NodeInfoViewProps> = ({
  controller,
  telemetry,
}) => {
  const [auditing, setAuditing] = useState(false);
  const [auditReport, setAuditReport] = useState<string | null>(null);

  const handleRunAudit = async () => {
    setAuditing(true);
    setAuditReport(null);
    try {
      const res = await controller.auditAndRepairReplication();
      setAuditReport(
        `Проверено блоков: ${res.total}, доступно: ${res.healthy}, восстановлено через Reed–Solomon: ${res.repaired}.`
      );
    } finally {
      setAuditing(false);
    }
  };

  const connectedPeers = telemetry.peers.filter((p) => p.connected);

  return (
    <div className="space-y-6">
      {/* Own Node Card */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Собственный сетевой узел MiX</h2>
            <p className="text-xs font-mono text-slate-500 dark:text-slate-400 mt-0.5">
              PeerID: {telemetry.peerId} · @{telemetry.login}
            </p>
          </div>
          <button
            type="button"
            disabled={auditing}
            onClick={handleRunAudit}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-xs font-medium whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${auditing ? 'animate-spin' : ''}`} />
            <span>{auditing ? 'Аудит блоков...' : 'Проверить и восстановить блоки'}</span>
          </button>
        </div>

        {auditReport && (
          <div className="p-3 rounded-lg bg-teal-50 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-900 text-xs text-teal-800 dark:text-teal-300">
            {auditReport}
          </div>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 pt-2 border-t border-slate-200 dark:border-slate-800 text-xs">
          <div>
            <div className="text-slate-500 dark:text-slate-400">Активные пиры</div>
            <div className="text-base font-semibold font-mono tabular-nums mt-0.5">
              {connectedPeers.length}
            </div>
          </div>
          <div>
            <div className="text-slate-500 dark:text-slate-400">Записи Kademlia DHT</div>
            <div className="text-base font-semibold font-mono tabular-nums mt-0.5">
              {telemetry.dhtRecordCount}
            </div>
          </div>
          <div>
            <div className="text-slate-500 dark:text-slate-400">Отслеживаемых файлов</div>
            <div className="text-base font-semibold font-mono tabular-nums mt-0.5">
              {telemetry.replicationHealth.trackedFiles} (восст. {telemetry.replicationHealth.repairedCount})
            </div>
          </div>
          <div>
            <div className="text-slate-500 dark:text-slate-400">Питание устройства</div>
            <div className="text-base font-semibold font-mono tabular-nums mt-0.5">
              {telemetry.batteryLevel === null
                ? 'Сеть / ПК'
                : `${Math.round(telemetry.batteryLevel * 100)}%${telemetry.charging ? ' (зарядка)' : ''}`}
            </div>
          </div>
        </div>
      </section>

      {/* Connected Peers Table */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <h2 className="text-base font-semibold mb-4">
          Подключённые узлы P2P-сети ({connectedPeers.length})
        </h2>
        {connectedPeers.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400 py-6 text-center">
            Другие узлы пока не обнаружены. Нажмите «Открыть второй узел» в верхней панели, чтобы соединить два живых P2P-узла прямо сейчас.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="py-2 pr-4 font-medium">PeerID</th>
                  <th className="py-2 pr-4 font-medium">Логин</th>
                  <th className="py-2 pr-4 font-medium">Транспорт</th>
                  <th className="py-2 pr-4 font-medium">RTT</th>
                  <th className="py-2 pr-4 font-medium">Свободно</th>
                  <th className="py-2 pr-4 font-medium">Репутация</th>
                  <th className="py-2 text-right font-medium">Активность</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {connectedPeers.map((p) => (
                  <tr key={p.peerId}>
                    <td className="py-2.5 pr-4 font-mono">{shortHash(p.peerId, 10, 6)}</td>
                    <td className="py-2.5 pr-4 font-mono">
                      {p.login ? `@${p.login}` : 'Аноним'}
                    </td>
                    <td className="py-2.5 pr-4">
                      {p.transport === 'webrtc'
                        ? 'WebRTC Direct'
                        : p.transport === 'broadcast'
                          ? 'Local Mesh'
                          : 'Voluntary Relay'}
                    </td>
                    <td className="py-2.5 pr-4 font-mono tabular-nums">
                      {p.rttMs !== null ? `${p.rttMs} мс` : '—'}
                    </td>
                    <td className="py-2.5 pr-4 font-mono tabular-nums">
                      {formatBytes(p.capabilities.freeStorageBytes)}
                    </td>
                    <td className="py-2.5 pr-4 font-mono tabular-nums">{p.reputation}/100</td>
                    <td className="py-2.5 text-right font-mono tabular-nums">
                      {formatDateTime(p.lastSeen)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Android & Mobile Background Constraints (Section 14) */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-2">
        <h2 className="text-sm font-semibold">
          Ограничения мобильных ОС (Android Doze / Background Execution)
        </h2>
        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
          На мобильных устройствах Android операционная система ограничивает длительную фоновую сетевую активность и может переводить сокеты в режим ожидания (Doze / App Standby). Смартфон не может гарантировать 100% постоянную доступность узла хранения без Foreground Service. Для круглосуточной раздачи блоков рекомендуется включать режим «Постоянный узел» на домашних ПК, мини-серверах или NAS, тогда как мобильные устройства автоматически восстанавливают недостающие копии и забирают офлайн-сообщения при возвращении в сеть.
        </p>
      </section>
    </div>
  );
};
