import React, { useRef, useState } from 'react';
import { Download, FileText, Paperclip, Plus, Send, UserMinus, UserPlus, Users } from 'lucide-react';
import type { MixNodeController } from '../MixNodeController';
import type { ContactEntry, FileManifest, GroupChat } from '../types';
import { formatBytes, formatTime } from './formatters';

interface GroupsViewProps {
  controller: MixNodeController;
  groups: GroupChat[];
  contacts: ContactEntry[];
}

export const GroupsView: React.FC<GroupsViewProps> = ({
  controller,
  groups,
  contacts,
}) => {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(
    groups[0]?.groupId ?? null
  );
  const [creating, setCreating] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [downloadUrls, setDownloadUrls] = useState<Record<string, string>>({});
  const [addMemberDid, setAddMemberDid] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const acceptedContacts = contacts.filter((c) => c.status === 'accepted');
  const activeGroup = groups.find((g) => g.groupId === selectedGroupId) ?? groups[0] ?? null;
  const myDid = controller.getSession()?.secret.did ?? '';
  const messages = activeGroup ? controller.getMessages(activeGroup.groupId) : [];

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupName.trim()) return;
    const created = await controller.createGroup(groupName, selectedMembers);
    setSelectedGroupId(created.groupId);
    setGroupName('');
    setSelectedMembers([]);
    setCreating(false);
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeGroup || !draft.trim()) return;
    const text = draft.trim();
    setDraft('');
    await controller.sendGroupMessage(activeGroup.groupId, text);
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeGroup) return;
    e.target.value = '';
    await controller.sendFileToConversation(activeGroup.groupId, true, file);
  };

  const handleDownload = async (msgId: string, manifest: FileManifest) => {
    const { blobUrl } = await controller.fileTransfer.downloadFile(manifest);
    setDownloadUrls((prev) => ({ ...prev, [msgId]: blobUrl }));
  };

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden grid grid-cols-1 md:grid-cols-12 min-h-[600px]">
        {/* Group List */}
        <aside className="md:col-span-4 border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-800 flex flex-col">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
              Приватные группы ({groups.length})
            </span>
            <button
              type="button"
              onClick={() => setCreating((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-teal-700 dark:text-teal-400 hover:underline whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Создать</span>
            </button>
          </div>

          {creating && (
            <form
              onSubmit={handleCreateGroup}
              className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-3 bg-slate-50 dark:bg-slate-950"
            >
              <input
                type="text"
                required
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="Название приватной группы"
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              {acceptedContacts.length > 0 && (
                <div className="space-y-1.5 max-h-32 overflow-y-auto">
                  <div className="text-[11px] text-slate-500">Участники:</div>
                  {acceptedContacts.map((c) => (
                    <label key={c.did} className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedMembers.includes(c.did)}
                        onChange={(e) =>
                          setSelectedMembers((prev) =>
                            e.target.checked
                              ? [...prev, c.did]
                              : prev.filter((id) => id !== c.did)
                          )
                        }
                      />
                      <span className="font-mono">@{c.login}</span>
                    </label>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="flex-1 px-3 py-1.5 rounded-lg bg-teal-700 text-white text-xs font-medium"
                >
                  Создать
                </button>
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs"
                >
                  Отмена
                </button>
              </div>
            </form>
          )}

          <div className="divide-y divide-slate-100 dark:divide-slate-800/70 flex-1 overflow-y-auto">
            {groups.length === 0 ? (
              <div className="p-6 text-xs text-slate-500 dark:text-slate-400">
                Создайте зашифрованную группу. При изменении состава участников общий ключ автоматически обновляется.
              </div>
            ) : (
              groups.map((g) => (
                <button
                  key={g.groupId}
                  type="button"
                  onClick={() => setSelectedGroupId(g.groupId)}
                  className={`w-full text-left px-4 py-3.5 transition-colors ${
                    activeGroup?.groupId === g.groupId
                      ? 'bg-teal-50/70 dark:bg-teal-950/30'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <div className="text-sm font-semibold truncate">{g.name}</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 font-mono">
                    Участников: {g.members.length} · Эпоха ключа #{g.keyEpoch}
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Active Group Thread */}
        <div className="md:col-span-8 flex flex-col">
          {!activeGroup ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-slate-500 dark:text-slate-400 gap-2">
              <Users className="w-7 h-7" />
              <p className="text-sm">Выберите или создайте приватную группу</p>
            </div>
          ) : (
            <>
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">{activeGroup.name}</div>
                  <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                    Ключ AES-256-GCM (эпоха #{activeGroup.keyEpoch}) · Участники:{' '}
                    {activeGroup.members.map((m) => `@${m.login}`).join(', ')}
                  </div>
                </div>

                {activeGroup.creatorDid === myDid && (
                  <div className="flex items-center gap-2">
                    <select
                      value={addMemberDid}
                      onChange={(e) => setAddMemberDid(e.target.value)}
                      className="px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      <option value="">Добавить участника...</option>
                      {acceptedContacts
                        .filter((c) => !activeGroup.members.some((m) => m.did === c.did))
                        .map((c) => (
                          <option key={c.did} value={c.did}>
                            @{c.login}
                          </option>
                        ))}
                    </select>
                    {addMemberDid && (
                      <button
                        type="button"
                        onClick={async () => {
                          await controller.addGroupMember(activeGroup.groupId, addMemberDid);
                          setAddMemberDid('');
                        }}
                        className="p-1.5 rounded bg-teal-700 text-white"
                        title="Пригласить и сменить ключ группы"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Member key-rotation management strip */}
              {activeGroup.creatorDid === myDid && activeGroup.members.length > 1 && (
                <div className="px-5 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 flex flex-wrap items-center gap-3 text-xs">
                  <span className="text-slate-500">Управление составом (ротация ключа):</span>
                  {activeGroup.members
                    .filter((m) => m.did !== myDid)
                    .map((m) => (
                      <button
                        key={m.did}
                        type="button"
                        onClick={() => controller.removeGroupMember(activeGroup.groupId, m.did)}
                        className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-300 hover:text-red-600 font-mono"
                        title="Исключить участника и ротировать ключ"
                      >
                        <span>@{m.login}</span>
                        <UserMinus className="w-3 h-3" />
                      </button>
                    ))}
                </div>
              )}

              <div className="flex-1 overflow-y-auto p-5 space-y-3 bg-slate-50/50 dark:bg-slate-950/40 max-h-[420px]">
                {messages.map((msg) => {
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
                            : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800'
                        }`}
                      >
                        {!mine && (
                          <div className="text-[11px] font-mono opacity-75 mb-1">
                            @{msg.senderLogin}
                          </div>
                        )}
                        <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                        {msg.fileManifest && (
                          <div className="mt-2 p-2 rounded border border-current/20 text-xs space-y-1">
                            <div className="flex items-center gap-2">
                              <FileText className="w-3.5 h-3.5" />
                              <span>{msg.fileManifest.fileName}</span>
                              <span className="font-mono">
                                ({formatBytes(msg.fileManifest.originalSize)})
                              </span>
                            </div>
                            {blobUrl ? (
                              <a
                                href={blobUrl}
                                download={msg.fileManifest.fileName}
                                className="inline-flex items-center gap-1 underline"
                              >
                                <Download className="w-3.5 h-3.5" />
                                <span>Сохранить</span>
                              </a>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleDownload(msg.id, msg.fileManifest!)}
                                className="underline"
                              >
                                Скачать и расшифровать
                              </button>
                            )}
                          </div>
                        )}
                        <div className="mt-1 text-[11px] opacity-70 text-right font-mono">
                          {formatTime(msg.createdAt)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <form
                onSubmit={handleSend}
                className="p-3.5 border-t border-slate-200 dark:border-slate-800 flex items-center gap-2"
              >
                <input ref={fileInputRef} type="file" onChange={handleFile} className="hidden" />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
                >
                  <Paperclip className="w-4 h-4" />
                </button>
                <input
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Сообщение в приватную группу..."
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
    </div>
  );
};
