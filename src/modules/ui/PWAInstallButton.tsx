import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from './usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'banner' | 'compact';
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  variant = 'compact',
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) return null;

  const handleClick = async () => {
    if (isInstallable) {
      await install();
      return;
    }
    setShowGuide(true);
  };

  return (
    <>
      {variant === 'banner' ? (
        <div className="bg-teal-50 dark:bg-teal-950/40 border border-teal-200 dark:border-teal-900 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <Smartphone className="w-5 h-5 text-teal-700 dark:text-teal-400 mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Установите MiX на телефон или компьютер
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                Работает как отдельное приложение с иконкой на экране, без магазинов приложений и регистрации.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClick}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-4 h-4" />
            <span>{isIOS ? 'Как установить на iPhone' : 'Установить приложение'}</span>
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-teal-600/40 text-teal-800 dark:text-teal-300 hover:bg-teal-50 dark:hover:bg-teal-950/40 text-xs font-medium whitespace-nowrap shrink-0 transition-colors"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Установить</span>
        </button>
      )}

      {showGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Установка приложения MiX</h3>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                aria-label="Закрыть"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isIOS ? (
              <ol className="text-sm text-slate-600 dark:text-slate-300 space-y-2 list-decimal list-inside">
                <li>Нажмите кнопку «Поделиться» (квадрат со стрелкой вверх) внизу экрана Safari.</li>
                <li>Пролистайте список вниз и нажмите «На экран «Домой»».</li>
                <li>Нажмите «Добавить» — иконка MiX появится на рабочем столе.</li>
              </ol>
            ) : (
              <ol className="text-sm text-slate-600 dark:text-slate-300 space-y-2 list-decimal list-inside">
                <li>Откройте этот адрес напрямую в Chrome на Android или в Chrome/Edge на компьютере.</li>
                <li>Нажмите на меню браузера (три точки в углу экрана).</li>
                <li>Выберите «Установить приложение» или «Добавить на главный экран».</li>
              </ol>
            )}

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="w-full py-2.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium"
            >
              Понятно
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 rounded-lg bg-amber-600 px-3.5 py-2 text-xs font-medium text-white shadow-sm">
      Нет подключения к интернету — доступен просмотр локальных данных
    </div>
  );
};
