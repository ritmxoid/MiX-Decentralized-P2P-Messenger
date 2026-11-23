import React from 'react';
import type { MixNodeController } from '../MixNodeController';
import type { NodeSettings } from '../types';

interface PrivacyViewProps {
  controller: MixNodeController;
  settings: NodeSettings;
}

export const PrivacyView: React.FC<PrivacyViewProps> = ({
  controller,
  settings,
}) => {
  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold">Защита IP-адресов и сетевых метаданных</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Сквозное шифрование скрывает содержимое, но для сокрытия факта общения и IP-адресов применяются многоступенчатая маршрутизация и выравнивание пакетов.
          </p>
        </div>

        <div className="space-y-4 text-sm">
          <label className="flex items-start justify-between gap-4 cursor-pointer">
            <div>
              <div className="font-medium">Многоступенчатая луковая маршрутизация (Onion Routing)</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Передача сообщений через 1–2 добровольных промежуточных узла со слоистым шифрованием X25519 + AES-256-GCM
              </div>
            </div>
            <input
              type="checkbox"
              checked={settings.onionRoutingEnabled}
              onChange={(e) =>
                controller.updateSettings({ onionRoutingEnabled: e.target.checked })
              }
              className="mt-1 rounded border-slate-300 text-teal-600"
            />
          </label>

          {settings.onionRoutingEnabled && (
            <div className="flex items-center justify-between gap-4 pl-1 pt-2 border-t border-slate-200 dark:border-slate-800">
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                Количество промежуточных узлов (хопов)
              </span>
              <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
                {([1, 2] as const).map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => controller.updateSettings({ onionHops: h })}
                    className={`px-3 py-1 text-xs font-medium rounded-md ${
                      settings.onionHops === h
                        ? 'bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-slate-100'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {h} {h === 1 ? 'узел' : 'узла'}
                  </button>
                ))}
              </div>
            </div>
          )}

          <label className="flex items-start justify-between gap-4 cursor-pointer pt-3 border-t border-slate-200 dark:border-slate-800">
            <div>
              <div className="font-medium">Выравнивание размера пакетов (Fixed-Bucket Padding)</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Дополняет конверты до фиксированных корзин (1 / 4 / 16 / 64 КБ), скрывая длину сообщений от наблюдателя
              </div>
            </div>
            <input
              type="checkbox"
              checked={settings.fixedPacketPadding}
              onChange={(e) =>
                controller.updateSettings({ fixedPacketPadding: e.target.checked })
              }
              className="mt-1 rounded border-slate-300 text-teal-600"
            />
          </label>

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800">
            <div className="flex justify-between text-xs mb-1.5">
              <span className="font-medium">Случайная задержка отправки (Timing Jitter)</span>
              <span className="font-mono tabular-nums">до {settings.timingJitterMs} мс</span>
            </div>
            <input
              type="range"
              min={0}
              max={500}
              step={20}
              value={settings.timingJitterMs}
              onChange={(e) =>
                controller.updateSettings({ timingJitterMs: Number(e.target.value) })
              }
              className="w-full accent-teal-600"
            />
          </div>

          <label className="flex items-start justify-between gap-4 cursor-pointer pt-3 border-t border-slate-200 dark:border-slate-800">
            <div>
              <div className="font-medium">Учитывать часовой пояс при балансировке хранения</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                По умолчанию отключено. Не передаёт точные координаты, только подсказку часового пояса.
              </div>
            </div>
            <input
              type="checkbox"
              checked={settings.shareGeoHint}
              onChange={(e) =>
                controller.updateSettings({ shareGeoHint: e.target.checked })
              }
              className="mt-1 rounded border-slate-300 text-teal-600"
            />
          </label>
        </div>
      </section>

      {/* Honest Threat Model (Section 10) */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
        <h2 className="text-base font-semibold">Честная модель угроз: границы защиты метаданных</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                <th className="py-2 pr-4 font-medium">Наблюдатель / Угроза</th>
                <th className="py-2 pr-4 font-medium">Статус защиты</th>
                <th className="py-2 font-medium">Техническое пояснение</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              <tr>
                <td className="py-2.5 pr-4 font-medium">Узел хранения файлов</td>
                <td className="py-2.5 pr-4 text-emerald-700 dark:text-emerald-400 font-medium">
                  Защищено
                </td>
                <td className="py-2.5 text-slate-600 dark:text-slate-400">
                  Хранит только фрагменты AES-256-GCM + Reed–Solomon без ключей и имён файлов.
                </td>
              </tr>
              <tr>
                <td className="py-2.5 pr-4 font-medium">Собеседник / Получатель IP</td>
                <td className="py-2.5 pr-4 text-emerald-700 dark:text-emerald-400 font-medium">
                  Смягчено при Onion / Relay
                </td>
                <td className="py-2.5 text-slate-600 dark:text-slate-400">
                  При включённой многоступенчатой маршрутизации собеседник получает пакет от последнего хопа. Важно: прямое соединение WebRTC ICE раскрывает IP-кандидаты — для строгой анонимности отключите прямое WebRTC в разделе «Сеть P2P».
                </td>
              </tr>
              <tr>
                <td className="py-2.5 pr-4 font-medium">Промежуточный ретранслятор</td>
                <td className="py-2.5 pr-4 text-emerald-700 dark:text-emerald-400 font-medium">
                  Защищено
                </td>
                <td className="py-2.5 text-slate-600 dark:text-slate-400">
                  Видит только предыдущий и следующий узел в цепочке из 2 хопов, а также выровненный размер пакета.
                </td>
              </tr>
              <tr>
                <td className="py-2.5 pr-4 font-medium">Глобальный пассивный наблюдатель (ISP/AS)</td>
                <td className="py-2.5 pr-4 text-amber-700 dark:text-amber-400 font-medium">
                  Ограничено
                </td>
                <td className="py-2.5 text-slate-600 dark:text-slate-400">
                  При одновременном прослушивании входа и выхода сети возможна статистическая корреляция времени, несмотря на jitter. Для защиты от глобального наблюдателя требуется внешний микснет (Tor/Nym).
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
