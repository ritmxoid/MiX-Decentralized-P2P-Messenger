import React, { useEffect, useState } from 'react';
import { Pause, Play, Trash2 } from 'lucide-react';
import type { MixNodeController } from '../MixNodeController';
import type { NodeSettings, NodeTelemetrySnapshot, StoredForeignShard } from '../types';
import { formatBytes, formatDateTime, shortHash } from './formatters';

interface StorageViewProps {
  controller: MixNodeController;
  settings: NodeSettings;
  telemetry: NodeTelemetrySnapshot;
}

export const StorageView: React.FC<StorageViewProps> = ({
  controller,
  settings,
  telemetry,
}) => {
  const [shards, setShards] = useState<StoredForeignShard[]>([]);

  const loadShards = async () => {
    const list = await controller.listStoredForeignShards();
    setShards(list);
  };

  useEffect(() => {
    loadShards().catch(() => {});
  }, [telemetry.foreignShardCount]);

  const usagePercent =
    telemetry.allocatedStorageBytes > 0
      ? Math.min(100, (telemetry.usedStorageBytes / telemetry.allocatedStorageBytes) * 100)
      : 0;

  const storageMb = Math.round(settings.maxStorageBytes / (1024 * 1024));

  return (
    <div className="space-y-6">
      {/* Summary KPI strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Выделено / Использовано</div>
          <div className="text-lg font-semibold font-mono tabular-nums mt-1">
            {formatBytes(telemetry.usedStorageBytes)} / {formatBytes(telemetry.allocatedStorageBytes)}
          </div>
          <div className="mt-2 h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-teal-600 transition-all"
              style={{ width: `${usagePercent}%` }}
            />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Хранимые блоки (чужие)</div>
          <div className="text-lg font-semibold font-mono tabular-nums mt-1">
            {telemetry.foreignShardCount}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Офлайн-конвертов: {telemetry.offlineEnvelopeCount}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Передано трафика</div>
          <div className="text-lg font-semibold font-mono tabular-nums mt-1">
            {formatBytes(telemetry.totalBytesSent + telemetry.totalBytesReceived)}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono tabular-nums">
            Отдано: {formatBytes(telemetry.totalBytesSent)}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Состояние узла хранения</div>
          <div className="text-lg font-semibold mt-1">
            {!telemetry.networkEnabled
              ? 'Сеть отключена'
              : telemetry.storageNodeActive
                ? 'Активен'
                : 'Приостановлен'}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono tabular-nums">
            Обслужено узлов: {telemetry.peers.filter((p) => p.connected).length} · Запросов:{' '}
            {telemetry.servedRequestsCount}
          </div>
        </div>
      </section>

      {/* Quota & Resource Controls */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Управление ресурсами узла</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Узел никогда не превысит установленный лимит. Все хранимые чужие блоки зашифрованы ключами отправителей.
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              controller.updateSettings({ storageNodeActive: !settings.storageNodeActive })
            }
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 ${
              settings.storageNodeActive
                ? 'border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'
                : 'bg-teal-700 text-white hover:bg-teal-800'
            }`}
          >
            {settings.storageNodeActive ? (
              <>
                <Pause className="w-3.5 h-3.5" />
                <span>Приостановить приём блоков</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                <span>Возобновить хранение</span>
              </>
            )}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="font-medium">Лимит пространства на диске</span>
              <span className="font-mono tabular-nums">{formatBytes(settings.maxStorageBytes)}</span>
            </div>
            <input
              type="range"
              min={64}
              max={10240}
              step={64}
              value={storageMb}
              onChange={(e) =>
                controller.updateSettings({
                  maxStorageBytes: Number(e.target.value) * 1024 * 1024,
                })
              }
              className="w-full accent-teal-600"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="font-medium">Лимит интернет-трафика в сутки</span>
              <span className="font-mono tabular-nums">{settings.maxTrafficMbPerDay} МБ</span>
            </div>
            <input
              type="range"
              min={128}
              max={20480}
              step={128}
              value={settings.maxTrafficMbPerDay}
              onChange={(e) =>
                controller.updateSettings({ maxTrafficMbPerDay: Number(e.target.value) })
              }
              className="w-full accent-teal-600"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="font-medium">Скорость отдачи другим участникам</span>
              <span className="font-mono tabular-nums">{settings.maxUploadBandwidthMbps} Мбит/с</span>
            </div>
            <input
              type="range"
              min={1}
              max={100}
              step={1}
              value={settings.maxUploadBandwidthMbps}
              onChange={(e) =>
                controller.updateSettings({ maxUploadBandwidthMbps: Number(e.target.value) })
              }
              className="w-full accent-teal-600"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-slate-200 dark:border-slate-800 text-xs">
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.allowMobileData}
              onChange={(e) =>
                controller.updateSettings({ allowMobileData: e.target.checked })
              }
              className="rounded border-slate-300 text-teal-600"
            />
            <span>Разрешить через мобильный интернет</span>
          </label>

          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.backgroundStorageEnabled}
              onChange={(e) =>
                controller.updateSettings({ backgroundStorageEnabled: e.target.checked })
              }
              className="rounded border-slate-300 text-teal-600"
            />
            <span>Хранение в фоновом режиме</span>
          </label>

          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.alwaysOnStorageNode}
              onChange={(e) =>
                controller.updateSettings({ alwaysOnStorageNode: e.target.checked })
              }
              className="rounded border-slate-300 text-teal-600"
            />
            <span>Режим постоянного узла (NAS / ПК)</span>
          </label>
        </div>
      </section>

      {/* Foreign Encrypted Shards Inspector */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold">Зашифрованные блоки сети в IndexedDB</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Непрозрачные криптографические фрагменты (владелец этого устройства не имеет ключей для их чтения)
            </p>
          </div>
          <span className="text-xs font-mono tabular-nums text-slate-500">
            Всего: {shards.length}
          </span>
        </div>

        {shards.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400 py-8 text-center">
            На этом устройстве пока не размещены блоки других участников.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="py-2 pr-4 font-medium">SHA-256 ID блока</th>
                  <th className="py-2 pr-4 font-medium">Размер</th>
                  <th className="py-2 pr-4 font-medium">Запросов</th>
                  <th className="py-2 pr-4 font-medium">Размещён</th>
                  <th className="py-2 text-right font-medium">Действие</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {shards.map((s) => (
                  <tr key={s.shardId}>
                    <td className="py-2.5 pr-4 font-mono">{shortHash(s.shardId, 14, 10)}</td>
                    <td className="py-2.5 pr-4 font-mono tabular-nums">{formatBytes(s.sizeBytes)}</td>
                    <td className="py-2.5 pr-4 font-mono tabular-nums">{s.accessCount}</td>
                    <td className="py-2.5 pr-4 font-mono tabular-nums">{formatDateTime(s.storedAt)}</td>
                    <td className="py-2.5 text-right">
                      <button
                        type="button"
                        onClick={async () => {
                          await controller.deleteForeignShardLocally(s.shardId);
                          await loadShards();
                        }}
                        className="inline-flex items-center gap-1 text-slate-500 hover:text-red-600"
                        title="Удалить блок локально (сеть восстановит копию через Reed-Solomon)"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Удалить</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
