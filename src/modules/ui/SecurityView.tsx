import React from 'react';
import { Moon, Sun } from 'lucide-react';
import type { MixNodeController } from '../MixNodeController';
import type { NodeSettings, NodeTelemetrySnapshot } from '../types';
import { formatTime } from './formatters';

interface SecurityViewProps {
  controller: MixNodeController;
  settings: NodeSettings;
  telemetry: NodeTelemetrySnapshot;
}

export const SecurityView: React.FC<SecurityViewProps> = ({
  controller,
  settings,
  telemetry,
}) => {
  const blockedPeers = controller.security.getBlockedPeers();

  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Защита от атак и злоумышленников</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Защита от Sybil-атак, DDoS, спама, подмены блоков и вредоносных узлов
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              controller.updateSettings({
                theme: settings.theme === 'dark' ? 'light' : 'dark',
              })
            }
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            {settings.theme === 'dark' ? (
              <>
                <Sun className="w-3.5 h-3.5" />
                <span>Светлая тема</span>
              </>
            ) : (
              <>
                <Moon className="w-3.5 h-3.5" />
                <span>Тёмная тема</span>
              </>
            )}
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="font-medium">Лимит запросов с одного узла (Rate Limit / мин)</span>
              <span className="font-mono tabular-nums">
                {settings.maxRequestsPerMinutePerPeer} запр./мин
              </span>
            </div>
            <input
              type="range"
              min={30}
              max={600}
              step={30}
              value={settings.maxRequestsPerMinutePerPeer}
              onChange={(e) =>
                controller.updateSettings({
                  maxRequestsPerMinutePerPeer: Number(e.target.value),
                })
              }
              className="w-full accent-teal-600"
            />
          </div>

          <label className="flex items-center justify-between gap-4 text-sm cursor-pointer pt-2 border-t border-slate-200 dark:border-slate-800">
            <div>
              <div className="font-medium">Проверка Proof-of-Work в таблице DHT (анти-Sybil)</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Отклоняет анонсы новых аккаунтов без криптографического доказательства работы
              </div>
            </div>
            <input
              type="checkbox"
              checked={settings.requirePowForDiscovery}
              onChange={(e) =>
                controller.updateSettings({ requirePowForDiscovery: e.target.checked })
              }
              className="rounded border-slate-300 text-teal-600"
            />
          </label>

          <label className="flex items-center justify-between gap-4 text-sm cursor-pointer pt-2 border-t border-slate-200 dark:border-slate-800">
            <div>
              <div className="font-medium">Автоматический карантин вредоносных узлов</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Блокирует узлы, отправляющие блоки с неверным SHA-256 или фальшивые подписи
              </div>
            </div>
            <input
              type="checkbox"
              checked={settings.autoQuarantineCorruptPeers}
              onChange={(e) =>
                controller.updateSettings({ autoQuarantineCorruptPeers: e.target.checked })
              }
              className="rounded border-slate-300 text-teal-600"
            />
          </label>
        </div>
      </section>

      {/* Blocked Peers */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <h2 className="text-sm font-semibold mb-3">
          Карантин и заблокированные узлы ({blockedPeers.length})
        </h2>
        {blockedPeers.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Заблокированных сетевых узлов нет.
          </p>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {blockedPeers.map((pid) => (
              <div key={pid} className="py-2.5 flex items-center justify-between gap-3">
                <span className="text-xs font-mono">{pid}</span>
                <button
                  type="button"
                  onClick={() => controller.security.unblockPeer(pid)}
                  className="px-3 py-1 rounded border border-slate-300 dark:border-slate-700 text-xs"
                >
                  Снять блокировку
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Local Security Audit Events */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <h2 className="text-sm font-semibold mb-3">
          Локальный журнал проверок безопасности (хранится только в памяти)
        </h2>
        {telemetry.securityEvents.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">Событий не зафиксировано.</p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800/70 max-h-64 overflow-y-auto">
            {telemetry.securityEvents.map((ev) => (
              <div key={ev.id} className="py-2 flex items-start justify-between gap-4 text-xs">
                <div>
                  <span
                    className={`font-medium mr-2 ${
                      ev.severity === 'blocked'
                        ? 'text-red-600 dark:text-red-400'
                        : ev.severity === 'warning'
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-teal-700 dark:text-teal-400'
                    }`}
                  >
                    {ev.severity === 'blocked'
                      ? 'Блокировка'
                      : ev.severity === 'warning'
                        ? 'Предупреждение'
                        : 'Проверка'}
                  </span>
                  <span className="text-slate-700 dark:text-slate-300">{ev.reason}</span>
                </div>
                <span className="font-mono tabular-nums text-slate-400 shrink-0">
                  {formatTime(ev.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
