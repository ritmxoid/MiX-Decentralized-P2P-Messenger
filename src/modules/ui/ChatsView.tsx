import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  CheckCheck,
  Clock,
  Download,
  Edit2,
  FileText,
  Mic,
  Paperclip,
  Send,
  Square,
  Trash2,
} from 'lucide-react';
import type { ShardTransferProgress } from '../fileTransfer/FileTransferModule';
import type { MixNodeController } from '../MixNodeController';
import type { ChatMessage, ContactEntry, FileManifest } from '../types';
import { formatBytes, formatTime } from './formatters';

interface ChatsViewProps {
  controller: MixNodeController;
  contacts: ContactEntry[];
  selectedContactDid: string | null;
  onSelectContact: (did: string) => void;
}

export const ChatsView: React.FC<ChatsViewProps> = ({
  controller,
  contacts,
  selectedContactDid,
  onSelectContact,
}) => {
  const activeContacts = contacts.filter(
    (c) => c.status === 'accepted' || c.status === 'pending_outgoing'
  );
  const currentContact =
    activeContacts.find((c) => c.did === selectedContactDid) ?? activeContacts[0] ?? null;

  const myDid = controller.getSession()?.secret.did ?? '';
  const messages = currentContact ? controller.getMessages(currentContact.did) : [];

  const [draft, setDraft] = useState('');
  const [ttlSeconds, setTtlSeconds] = useState<number>(0);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [uploadProgress, setUploadProgress] = useState<ShardTransferProgress | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadUrls, setDownloadUrls] = useState<Record<string, string>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Voice recording via MediaRecorder
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recStartedAtRef = useRef<number>(0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (currentContact) {
      controller.markConversationRead(currentContact.did).catch(() => {});
    }
  }, [currentContact?.did, messages.length]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, currentContact?.did]);

  const handleSendText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentContact || !draft.trim()) return;
    setErrorMsg(null);
    const text = draft.trim();
    setDraft('');
    try {
      await controller.sendDirectMessage(currentContact.did, text, {
        ttlSeconds: ttlSeconds > 0 ? ttlSeconds : undefined,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Ошибка отправки');
    }
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentContact) return;
    e.target.value = '';
    setErrorMsg(null);
    try {
      await controller.sendFileToConversation(
        currentContact.did,
        false,
        file,
        (p) => setUploadProgress(p),
        ttlSeconds > 0 ? ttlSeconds : undefined
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Ошибка передачи файла');
    } finally {
      setTimeout(() => setUploadProgress(null), 1000);
    }
  };

  const startVoiceRecording = async () => {
    if (!currentContact || !navigator.mediaDevices?.getUserMedia) {
      setErrorMsg('Запись аудио не поддерживается в текущем окружении браузера');
      return;
    }
    setErrorMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      recChunksRef.current = [];
      recStartedAtRef.current = Date.now();
      setRecSeconds(0);

      mr.ondataavailable = (ev) => {
        if (ev.data.size > 0) recChunksRef.current.push(ev.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recTimerRef.current) clearInterval(recTimerRef.current);
        const duration = Math.max(1, Math.round((Date.now() - recStartedAtRef.current) / 1000));
        const blob = new Blob(recChunksRef.current, { type: mr.mimeType || 'audio/webm' });
        if (blob.size > 0 && currentContact) {
          try {
            await controller.sendVoiceMessage(
              currentContact.did,
              false,
              blob,
              duration,
              ttlSeconds > 0 ? ttlSeconds : undefined
            );
          } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : 'Ошибка отправки аудио');
          }
        }
        setRecording(false);
      };

      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
      recTimerRef.current = setInterval(() => {
        setRecSeconds(Math.round((Date.now() - recStartedAtRef.current) / 1000));
      }, 500);
    } catch {
      setErrorMsg('Доступ к микрофону отклонён или устройство не обнаружено');
    }
  };

  const stopVoiceRecording = () => {
    mediaRecorderRef.current?.stop();
  };

  const handleDownloadFile = async (msgId: string, manifest: FileManifest) => {
    setErrorMsg(null);
    setDownloadingId(msgId);
    try {
      const { blobUrl } = await controller.fileTransfer.downloadFile(manifest);
      setDownloadUrls((prev) => ({ ...prev, [msgId]: blobUrl }));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Не удалось восстановить файл из блоков');
    } finally {
      setDownloadingId(null);
    }
  };

  const renderStatus = (msg: ChatMessage) => {
    if (msg.senderDid !== myDid) return null;
    if (msg.status === 'read') return <CheckCheck className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />;
    if (msg.status === 'delivered') return <CheckCheck className="w-3.5 h-3.5 text-slate-400" />;
    if (msg.status === 'stored_offline') return <Clock className="w-3.5 h-3.5 text-amber-600" />;
    return <Check className="w-3.5 h-3.5 text-slate-400" />;
  };

  const phaseLabel: Record<ShardTransferProgress['phase'], string> = {
    encrypting: 'Шифрование AES-256-GCM',
    encoding: 'Кодирование Рида–Соломона (4+2)',
    distributing: 'Распределение блоков по узлам',
    fetching: 'Скачивание блоков с узлов',
    recovering: 'Восстановление данных',
    decrypting: 'Расшифровка на устройстве',
    done: 'Готово',
  };

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden grid grid-cols-1 md:grid-cols-12 min-h-[620px]">
      {/* Conversations list */}
      <aside className="md:col-span-4 border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-800 flex flex-col">
        <div className="px-4 py-3.5 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 dark:text-slate-400">
          Личные чаты ({activeContacts.length})
        </div>
        {activeContacts.length === 0 ? (
          <div className="p-6 text-xs text-slate-500 dark:text-slate-400">
            Добавьте контакт в разделе «Контакты и поиск», чтобы начать зашифрованную переписку.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800/70 overflow-y-auto flex-1">
            {activeContacts.map((c) => {
              const selected = currentContact?.did === c.did;
              const online = controller.p2p.getConnectedPeers().some((p) => p.did === c.did);
              const convMsgs = controller.getMessages(c.did);
              const last = convMsgs[convMsgs.length - 1];
              return (
                <button
                  key={c.did}
                  type="button"
                  onClick={() => onSelectContact(c.did)}
                  className={`w-full text-left px-4 py-3.5 transition-colors ${
                    selected
                      ? 'bg-teal-50/70 dark:bg-teal-950/30'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold font-mono truncate">@{c.login}</span>
                    <span className="text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      {online ? 'онлайн' : 'офлайн'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-1">
                    {last ? last.text : 'Нет сообщений'}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </aside>

      {/* Active Chat Area */}
      <div className="md:col-span-8 flex flex-col">
        {!currentContact ? (
          <div className="flex-1 flex items-center justify-center p-8 text-sm text-slate-500 dark:text-slate-400">
            Выберите контакт для начала сквозной E2EE-переписки
          </div>
        ) : (
          <>
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold font-mono">@{currentContact.login}</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  X25519 + AES-256-GCM · Подпись Ed25519
                  {controller.getSettings().onionRoutingEnabled ? ' · Многоступенчатый маршрут' : ''}
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <label className="text-slate-500 dark:text-slate-400">Автоудаление:</label>
                <select
                  value={ttlSeconds}
                  onChange={(e) => setTtlSeconds(Number(e.target.value))}
                  className="px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs"
                >
                  <option value={0}>Выкл</option>
                  <option value={30}>30 сек</option>
                  <option value={300}>5 мин</option>
                  <option value={3600}>1 час</option>
                </select>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-3 bg-slate-50/50 dark:bg-slate-950/40 max-h-[450px]">
              {messages.length === 0 ? (
                <p className="text-center text-xs text-slate-500 dark:text-slate-400 py-12">
                  Сообщений пока нет. Отправьте текст, голосовое сообщение или файл любого типа.
                </p>
              ) : (
                messages.map((msg) => {
                  const mine = msg.senderDid === myDid;
                  const blobUrl = downloadUrls[msg.id];
                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}
                    >
                      <div
                        className={`max-w-[85%] rounded-xl px-4 py-2.5 border text-sm ${
                          mine
                            ? 'bg-teal-700 text-white border-teal-700'
                            : 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 border-slate-200 dark:border-slate-800'
                        }`}
                      >
                        {editingMsgId === msg.id ? (
                          <form
                            onSubmit={async (e) => {
                              e.preventDefault();
                              if (editValue.trim()) {
                                await controller.editMessage(msg.id, editValue.trim());
                              }
                              setEditingMsgId(null);
                            }}
                            className="flex items-center gap-2"
                          >
                            <input
                              type="text"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              className="px-2 py-1 rounded text-xs text-slate-900 bg-white"
                            />
                            <button type="submit" className="text-xs underline">
                              Сохранить
                            </button>
                          </form>
                        ) : (
                          <p className={msg.deleted ? 'italic opacity-70 text-xs' : 'whitespace-pre-wrap break-words'}>
                            {msg.text}
                          </p>
                        )}

                        {msg.fileManifest && !msg.deleted && (
                          <div
                            className={`mt-2.5 p-2.5 rounded-lg border text-xs space-y-2 ${
                              mine
                                ? 'bg-teal-800/60 border-teal-600/50 text-teal-50'
                                : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2 min-w-0">
                                <FileText className="w-4 h-4 shrink-0" />
                                <span className="truncate font-medium">
                                  {msg.fileManifest.fileName}
                                </span>
                              </div>
                              <span className="font-mono tabular-nums shrink-0 opacity-80">
                                {formatBytes(msg.fileManifest.originalSize)}
                              </span>
                            </div>
                            <div className="text-[11px] opacity-80 font-mono">
                              Блоков RS: {msg.fileManifest.dataShards}+{msg.fileManifest.parityShards} · Узлов:{' '}
                              {
                                new Set(msg.fileManifest.shards.flatMap((s) => s.holders))
                                  .size
                              }
                            </div>

                            {blobUrl ? (
                              <div className="space-y-2">
                                {msg.kind === 'image' && (
                                  <img
                                    src={blobUrl}
                                    alt={msg.fileManifest.fileName}
                                    className="max-h-48 rounded-md object-contain"
                                  />
                                )}
                                {msg.kind === 'video' && (
                                  <video src={blobUrl} controls className="max-h-48 rounded-md w-full" />
                                )}
                                {msg.kind === 'voice' && (
                                  <audio src={blobUrl} controls className="w-full h-8" />
                                )}
                                <a
                                  href={blobUrl}
                                  download={msg.fileManifest.fileName}
                                  className="inline-flex items-center gap-1.5 underline font-medium"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                  <span>Сохранить расшифрованный файл</span>
                                </a>
                              </div>
                            ) : (
                              <button
                                type="button"
                                disabled={downloadingId === msg.id}
                                onClick={() => handleDownloadFile(msg.id, msg.fileManifest!)}
                                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded font-medium ${
                                  mine
                                    ? 'bg-white text-teal-800 hover:bg-teal-50'
                                    : 'bg-teal-700 text-white hover:bg-teal-800'
                                }`}
                              >
                                <Download className="w-3.5 h-3.5" />
                                <span>
                                  {downloadingId === msg.id
                                    ? 'Сборка и расшифровка блоков...'
                                    : 'Скачать и расшифровать'}
                                </span>
                              </button>
                            )}
                          </div>
                        )}

                        <div
                          className={`mt-1.5 flex items-center justify-end gap-2 text-[11px] ${
                            mine ? 'text-teal-100/80' : 'text-slate-400'
                          }`}
                        >
                          {msg.ttlSeconds && <span>Таймер {msg.ttlSeconds}с</span>}
                          {msg.editedAt && <span>изм.</span>}
                          <span className="font-mono tabular-nums">{formatTime(msg.createdAt)}</span>
                          {renderStatus(msg)}
                          {mine && !msg.deleted && (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingMsgId(msg.id);
                                  setEditValue(msg.text);
                                }}
                                aria-label="Редактировать"
                                className="hover:opacity-100 opacity-75"
                              >
                                <Edit2 className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => controller.deleteMessage(msg.id)}
                                aria-label="Удалить"
                                className="hover:opacity-100 opacity-75"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>

            {uploadProgress && (
              <div className="px-5 py-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs flex items-center justify-between">
                <span>{phaseLabel[uploadProgress.phase]}</span>
                <span className="font-mono tabular-nums">
                  {uploadProgress.completed}/{uploadProgress.total}
                </span>
              </div>
            )}

            {errorMsg && (
              <div className="px-5 py-2 border-t border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
                {errorMsg}
              </div>
            )}

            <form
              onSubmit={handleSendText}
              className="p-3.5 border-t border-slate-200 dark:border-slate-800 flex items-center gap-2"
            >
              <input
                ref={fileInputRef}
                type="file"
                onChange={handleFileSelected}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                title="Отправить файл (изображение, видео, документ, архив)"
              >
                <Paperclip className="w-4 h-4" />
              </button>

              {recording ? (
                <button
                  type="button"
                  onClick={stopVoiceRecording}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-600 text-white text-xs font-medium whitespace-nowrap"
                >
                  <Square className="w-3.5 h-3.5" />
                  <span className="font-mono tabular-nums">{recSeconds}с</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startVoiceRecording}
                  className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                  title="Записать голосовое сообщение"
                >
                  <Mic className="w-4 h-4" />
                </button>
              )}

              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Зашифрованное сообщение..."
                className="flex-1 px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
              <button
                type="submit"
                disabled={!draft.trim()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-sm font-medium whitespace-nowrap shrink-0"
              >
                <Send className="w-4 h-4" />
                <span className="hidden sm:inline">Отправить</span>
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
};
