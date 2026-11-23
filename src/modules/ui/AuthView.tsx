import React, { useState } from 'react';
import { Eye, EyeOff, KeyRound, Lock, ShieldCheck, Upload } from 'lucide-react';
import type { MixNodeController } from '../MixNodeController';
import { formatBytes } from './formatters';
import { OfflineIndicator, PWAInstallButton } from './PWAInstallButton';
import { DownloadsPanel } from './DownloadsPanel';

interface AuthViewProps {
  controller: MixNodeController;
  hasExistingAccount: boolean;
  existingLogin: string | null;
}

export const AuthView: React.FC<AuthViewProps> = ({
  controller,
  hasExistingAccount,
  existingLogin,
}) => {
  const [mode, setMode] = useState<'login' | 'create' | 'import'>(
    hasExistingAccount ? 'login' : 'create'
  );
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Simple 2-slider resource contribution for 99.9% of regular users
  const [storageMb, setStorageMb] = useState(512);
  const [trafficMb, setTrafficMb] = useState(2048);

  const [backupJson, setBackupJson] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === 'create') {
        if (password !== confirmPassword) {
          throw new Error('Пароли не совпадают');
        }
        await controller.createAccount(login, password, {
          maxStorageBytes: storageMb * 1024 * 1024,
          maxTrafficMbPerDay: trafficMb,
          allowMobileData: true,
          backgroundStorageEnabled: true,
          alwaysOnStorageNode: false,
          storageNodeActive: true,
        });
      } else if (mode === 'login') {
        await controller.unlockAccount(password);
      } else {
        if (!backupJson.trim()) {
          throw new Error('Выберите файл .mixkey или вставьте содержимое резервной копии');
        }
        await controller.importBackupAndUnlock(backupJson, password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка аутентификации');
    } finally {
      setLoading(false);
    }
  };

  const handleBackupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setBackupJson(text);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 flex flex-col">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <span className="text-lg font-bold tracking-tight whitespace-nowrap shrink-0">
            MiX
          </span>
          <PWAInstallButton variant="compact" />
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-10 space-y-6">
        <PWAInstallButton variant="banner" />

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left: Plain-language value proposition */}
          <section className="lg:col-span-5 space-y-5 pt-1">
            <div className="space-y-2.5">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50 [text-wrap:balance]">
                Анонимный мессенджер без серверов и номера телефона
              </h1>
              <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                Придумайте логин и пароль — ключи шифрования создадутся прямо на вашем телефоне или компьютере. Никакой почты, SMS или привязки к аккаунтам.
              </p>
            </div>

            <div className="border-t border-slate-200 dark:border-slate-800 pt-5 space-y-3.5 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              <div>
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  1. Только логин и пароль.
                </span>{' '}
                Ваш аккаунт не хранится ни на каком чужом сервере.
              </div>
              <div>
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  2. Шифрование сообщений и файлов.
                </span>{' '}
                Прочитать переписку можете только вы и ваш собеседник.
              </div>
              <div>
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  3. Общая сеть участников.
                </span>{' '}
                Вы сами выбираете, сколько места и трафика выделить для обмена зашифрованными файлами.
              </div>
            </div>
          </section>

          {/* Right: Simple Account Creation / Login / Restore */}
          <section className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-7">
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg mb-6">
              {hasExistingAccount && (
                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setError(null);
                  }}
                  className={`flex-1 px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    mode === 'login'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  Вход
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setMode('create');
                  setError(null);
                }}
                className={`flex-1 px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  mode === 'create'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                Новый аккаунт
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('import');
                  setError(null);
                }}
                className={`flex-1 px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  mode === 'import'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                Из резервной копии
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              {mode === 'login' && (
                <div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Ваш логин на этом устройстве</p>
                  <p className="text-base font-semibold mt-0.5 font-mono">@{existingLogin}</p>
                </div>
              )}

              {mode === 'create' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Придумайте логин
                  </label>
                  <input
                    type="text"
                    required
                    value={login}
                    onChange={(e) => setLogin(e.target.value)}
                    placeholder="например, alex77"
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Латинские буквы, цифры, точка или подчёркивание (от 3 символов)
                  </p>
                </div>
              )}

              {mode === 'import' && (
                <div className="space-y-3">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Файл резервной копии (.mixkey)
                  </label>
                  <label className="flex items-center justify-center gap-2 px-4 py-3 border border-dashed border-slate-300 dark:border-slate-700 rounded-lg cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 text-xs font-medium text-slate-700 dark:text-slate-300">
                    <Upload className="w-4 h-4" />
                    <span>Выбрать файл .mixkey</span>
                    <input
                      type="file"
                      accept=".mixkey,.json,application/json"
                      onChange={handleBackupFile}
                      className="hidden"
                    />
                  </label>
                  <textarea
                    rows={3}
                    value={backupJson}
                    onChange={(e) => setBackupJson(e.target.value)}
                    placeholder="Или вставьте текст резервной копии..."
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Пароль
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Минимум 6 символов"
                    className="w-full px-3.5 py-2.5 pr-10 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                    aria-label="Показать пароль"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {mode === 'create' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Повторите пароль
                    </label>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      minLength={6}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Повторите пароль"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                  </div>

                  {/* Only 2 simple sliders: space + traffic */}
                  <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-4">
                    <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Сколько ресурсов выделить для работы сети
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-slate-600 dark:text-slate-400">Место на устройстве</span>
                          <span className="font-mono tabular-nums font-medium">
                            {formatBytes(storageMb * 1024 * 1024)}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={64}
                          max={4096}
                          step={64}
                          value={storageMb}
                          onChange={(e) => setStorageMb(Number(e.target.value))}
                          className="w-full accent-teal-600"
                        />
                      </div>
                      <div>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-slate-600 dark:text-slate-400">Трафик в день</span>
                          <span className="font-mono tabular-nums font-medium">
                            {trafficMb >= 1024 ? `${(trafficMb / 1024).toFixed(1)} ГБ` : `${trafficMb} МБ`}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={256}
                          max={10240}
                          step={256}
                          value={trafficMb}
                          onChange={(e) => setTrafficMb(Number(e.target.value))}
                          className="w-full accent-teal-600"
                        />
                      </div>
                    </div>
                  </div>
                </>
              )}

              {error && (
                <div className="p-3 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-sm font-medium transition-colors whitespace-nowrap"
              >
                {mode === 'create' ? (
                  <>
                    <KeyRound className="w-4 h-4" />
                    <span>{loading ? 'Создание ключей...' : 'Создать аккаунт и войти'}</span>
                  </>
                ) : mode === 'login' ? (
                  <>
                    <Lock className="w-4 h-4" />
                    <span>{loading ? 'Проверка пароля...' : 'Войти'}</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-4 h-4" />
                    <span>{loading ? 'Восстановление...' : 'Восстановить и войти'}</span>
                  </>
                )}
              </button>
            </form>
          </section>
        </div>

        <DownloadsPanel />
      </main>
      <OfflineIndicator />
    </div>
  );
};
