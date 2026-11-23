import React, { useState } from 'react';
import { Download, Monitor, Smartphone, Settings2, Check } from 'lucide-react';

const REPO_STORAGE_KEY = 'mix_github_repo';
const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

function getInitialRepo(): string {
  const envRepo = (
    import.meta as unknown as { env?: Record<string, string | undefined> }
  ).env?.VITE_GITHUB_REPO?.trim();
  if (envRepo && REPO_PATTERN.test(envRepo)) return envRepo;
  try {
    const saved = localStorage.getItem(REPO_STORAGE_KEY)?.trim() || '';
    return REPO_PATTERN.test(saved) ? saved : '';
  } catch {
    return '';
  }
}

export const DownloadsPanel: React.FC = () => {
  const envRepo = (
    import.meta as unknown as { env?: Record<string, string | undefined> }
  ).env?.VITE_GITHUB_REPO?.trim() || '';

  const [repo, setRepo] = useState<string>(getInitialRepo);
  const [draftRepo, setDraftRepo] = useState<string>(getInitialRepo);
  const [editing, setEditing] = useState<boolean>(false);
  const [repoError, setRepoError] = useState<string | null>(null);

  const hasValidRepo = REPO_PATTERN.test(repo);
  const exeUrl = hasValidRepo
    ? `https://github.com/${repo}/releases/latest/download/MiX-Setup.exe`
    : undefined;
  const apkUrl = hasValidRepo
    ? `https://github.com/${repo}/releases/latest/download/MiX-Android.apk`
    : undefined;
  const releasesUrl = hasValidRepo
    ? `https://github.com/${repo}/releases/latest`
    : undefined;

  const handleSaveRepo = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = draftRepo
      .trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\/+$/, '');
    if (!REPO_PATTERN.test(cleaned)) {
      setRepoError('Укажите репозиторий в формате owner/repo, например user/mix-messenger');
      return;
    }
    setRepoError(null);
    setRepo(cleaned);
    setDraftRepo(cleaned);
    setEditing(false);
    try {
      localStorage.setItem(REPO_STORAGE_KEY, cleaned);
    } catch {
      // ignore storage failure
    }
  };

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Скачать готовые приложения для Windows и Android
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Установщик Windows (.exe) автоматически запускает встроенный P2P-узел в локальной сети, а приложение Android (.apk) работает как мобильный клиент и хранилище.
          </p>
        </div>
        {!envRepo && (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 whitespace-nowrap shrink-0"
          >
            <Settings2 className="w-3.5 h-3.5" />
            <span>{hasValidRepo ? 'Сменить GitHub-репозиторий' : 'Привязать GitHub Releases'}</span>
          </button>
        )}
      </div>

      {(!hasValidRepo || editing) && !envRepo && (
        <form
          onSubmit={handleSaveRepo}
          className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2.5"
        >
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Укажите ваш GitHub-репозиторий (owner/repo), в котором выполнен Actions-сборщик релизов
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={draftRepo}
              onChange={(e) => setDraftRepo(e.target.value)}
              placeholder="например, myname/mix-messenger"
              className="flex-1 px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium whitespace-nowrap"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Сохранить ссылки</span>
            </button>
          </div>
          {repoError && (
            <p className="text-xs text-red-600 dark:text-red-400">{repoError}</p>
          )}
        </form>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 flex flex-col justify-between gap-3">
          <div className="flex items-start gap-3">
            <Monitor className="w-5 h-5 text-teal-600 shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Windows 10 / 11 (.exe)
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                Устанавливается в пару кликов. Автоматически поднимает встроенный P2P-рендеву и ретранслятор на порту 39140 для смартфонов в Wi-Fi.
              </p>
            </div>
          </div>
          {exeUrl ? (
            <a
              href={exeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium hover:opacity-90 transition-opacity whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Скачать MiX-Setup.exe</span>
            </a>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              <Settings2 className="w-3.5 h-3.5" />
              <span>Указать GitHub-репозиторий</span>
            </button>
          )}
        </div>

        <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 flex flex-col justify-between gap-3">
          <div className="flex items-start gap-3">
            <Smartphone className="w-5 h-5 text-teal-600 shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Android 8+ (.apk)
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                Отдельное приложение с доступом к памяти и микрофону. Подключается к ПК по Wi-Fi или к общему адресу ретранслятора.
              </p>
            </div>
          </div>
          {apkUrl ? (
            <a
              href={apkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Скачать MiX-Android.apk</span>
            </a>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              <Settings2 className="w-3.5 h-3.5" />
              <span>Указать GitHub-репозиторий</span>
            </button>
          )}
        </div>
      </div>

      {releasesUrl && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400 pt-1">
          <span>
            Релизы: <span className="font-mono text-slate-700 dark:text-slate-300">{repo}</span>
          </span>
          <a
            href={releasesUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-teal-700 dark:text-teal-400 hover:underline font-medium"
          >
            Все версии на GitHub Releases
          </a>
        </div>
      )}
    </section>
  );
};
