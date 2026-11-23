import React, { useState } from 'react';
import { Copy, Download, Upload } from 'lucide-react';
import type { MixNodeController } from '../MixNodeController';

interface BackupsViewProps {
  controller: MixNodeController;
}

export const BackupsView: React.FC<BackupsViewProps> = ({ controller }) => {
  const session = controller.getSession();
  const [copied, setCopied] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!session) return null;

  const edFingerprint = controller.identity.getKeyFingerprint(
    session.secret.ed25519PublicKey
  );
  const xFingerprint = controller.identity.getKeyFingerprint(
    session.secret.x25519PublicKey
  );

  const handleDownloadBackup = () => {
    const json = controller.exportBackupJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mix-identity-${session.secret.login}.mixkey`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyJson = async () => {
    const json = controller.exportBackupJson();
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      await controller.importBackupAndUnlock(importJson, importPassword);
      setImportJson('');
      setImportPassword('');
      setStatusMsg('Резервная копия успешно проверена, расшифрована и активирована.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Ошибка восстановления');
    }
  };

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportJson(await file.text());
  };

  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold">Криптографическая идентичность устройства</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Закрытые ключи никогда не покидают устройство в открытом виде. Резервная копия зашифрована ключом Argon2id + AES-256-GCM.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs pt-2">
          <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 space-y-1">
            <div className="text-slate-500 dark:text-slate-400">Логин и DID</div>
            <div className="font-mono font-semibold text-sm">@{session.secret.login}</div>
            <div className="font-mono text-[11px] text-slate-600 dark:text-slate-400 break-all">
              {session.secret.did}
            </div>
          </div>

          <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 space-y-1">
            <div className="text-slate-500 dark:text-slate-400">Отпечатки публичных ключей</div>
            <div className="font-mono text-[11px]">Ed25519: {edFingerprint}</div>
            <div className="font-mono text-[11px]">X25519: {xFingerprint}</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button
            type="button"
            onClick={handleDownloadBackup}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Скачать зашифрованный файл .mixkey</span>
          </button>

          <button
            type="button"
            onClick={handleCopyJson}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium whitespace-nowrap"
          >
            <Copy className="w-3.5 h-3.5" />
            <span>{copied ? 'JSON скопирован' : 'Копировать зашифрованный JSON'}</span>
          </button>
        </div>
      </section>

      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
        <h2 className="text-base font-semibold">Импорт другой резервной копии (.mixkey)</h2>
        <form onSubmit={handleRestore} className="space-y-4">
          <label className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800">
            <Upload className="w-3.5 h-3.5" />
            <span>Загрузить файл .mixkey</span>
            <input
              type="file"
              accept=".mixkey,.json,application/json"
              onChange={handleFilePick}
              className="hidden"
            />
          </label>

          <textarea
            rows={4}
            required
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            placeholder="Содержимое .mixkey (JSON)..."
            className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          />

          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="password"
              required
              minLength={6}
              value={importPassword}
              onChange={(e) => setImportPassword(e.target.value)}
              placeholder="Пароль от резервной копии"
              className="flex-1 px-3.5 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium whitespace-nowrap"
            >
              Восстановить идентичность
            </button>
          </div>

          {statusMsg && (
            <p className="text-xs text-emerald-700 dark:text-emerald-400">{statusMsg}</p>
          )}
          {errorMsg && (
            <p className="text-xs text-red-600 dark:text-red-400">{errorMsg}</p>
          )}
        </form>
      </section>
    </div>
  );
};
