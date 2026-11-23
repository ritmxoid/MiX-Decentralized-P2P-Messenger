import React, { useState } from 'react';
import {
  Ban,
  Check,
  MessageSquare,
  Search,
  UserPlus,
  Users,
} from 'lucide-react';
import type { MixNodeController } from '../MixNodeController';
import type { ContactEntry, IdentityPublicCard } from '../types';
import { shortHash } from './formatters';

interface ContactsViewProps {
  controller: MixNodeController;
  contacts: ContactEntry[];
  onOpenChat: (did: string) => void;
}

export const ContactsView: React.FC<ContactsViewProps> = ({
  controller,
  contacts,
  onOpenChat,
}) => {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<IdentityPublicCard | null>(null);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);

  const discovered = controller.getDiscoveredNetworkIdentities();
  const connectedPeers = controller.p2p.getConnectedPeers();

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = query.trim().replace(/^@+/, '');
    if (!clean) return;
    setSearching(true);
    setSearchResult(null);
    setSearchMessage(null);
    try {
      const found = await controller.searchUserByLogin(clean);
      if (found) {
        setSearchResult(found);
      } else {
        setSearchMessage(
          `Узел с логином @${clean} не найден в таблице DHT. Убедитесь, что участник онлайн или подключён к сети.`
        );
      }
    } finally {
      setSearching(false);
    }
  };

  const handleAddContact = async (card: IdentityPublicCard) => {
    await controller.sendContactRequest(card);
    setSearchResult(null);
    setQuery('');
  };

  const isOnline = (did: string) => connectedPeers.some((p) => p.did === did && p.connected);

  const incoming = contacts.filter((c) => c.status === 'pending_incoming');
  const active = contacts.filter(
    (c) => c.status === 'accepted' || c.status === 'pending_outgoing'
  );
  const blocked = contacts.filter((c) => c.status === 'blocked');

  return (
    <div className="space-y-8">
      {/* DHT Search */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Поиск участников в Kademlia DHT
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Децентрализованный поиск по логину с проверкой подписи Ed25519 и Proof-of-Work
            </p>
          </div>
          <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
            Записей DHT: {controller.discovery.getRecordCount()}
          </span>
        </div>

        <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Введите логин (например, node_beta)"
              className="w-full pl-10 pr-4 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>
          <button
            type="submit"
            disabled={searching || !query.trim()}
            className="px-5 py-2.5 rounded-lg bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-sm font-medium transition-colors whitespace-nowrap shrink-0"
          >
            {searching ? 'Поиск в DHT...' : 'Найти узел'}
          </button>
        </form>

        {searchResult && (
          <div className="mt-4 p-4 rounded-lg border border-teal-200 dark:border-teal-900 bg-teal-50/50 dark:bg-teal-950/20 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1 min-w-0">
              <div className="text-sm font-semibold font-mono text-slate-900 dark:text-slate-100">
                @{searchResult.login}
              </div>
              <div className="text-xs font-mono text-slate-600 dark:text-slate-400 truncate">
                {searchResult.did} · PoW {searchResult.powDifficulty} бит · Подпись Ed25519 подтверждена
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleAddContact(searchResult)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium whitespace-nowrap shrink-0"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Отправить запрос</span>
            </button>
          </div>
        )}

        {searchMessage && (
          <p className="mt-3 text-xs text-slate-600 dark:text-slate-400">{searchMessage}</p>
        )}
      </section>

      {/* Incoming Requests */}
      {incoming.length > 0 && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">
            Входящие запросы на общение ({incoming.length})
          </h2>
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {incoming.map((c) => (
              <div
                key={c.did}
                className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold font-mono">@{c.login}</div>
                  <div className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate">
                    {c.did}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => controller.acceptContactRequest(c.did)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium whitespace-nowrap"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Принять</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => controller.blockContact(c.did)}
                    className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                  >
                    Заблокировать
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Contacts List */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Контакты ({active.length})
          </h2>
        </div>

        {active.length === 0 ? (
          <div className="py-10 text-center space-y-2">
            <Users className="w-8 h-8 text-slate-400 mx-auto" />
            <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Список контактов пока пуст
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Найдите собеседника по логину выше или откройте второй локальный узел в новой вкладке, чтобы проверить прямое P2P-соединение.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {active.map((c) => {
              const online = isOnline(c.did);
              return (
                <div
                  key={c.did}
                  className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2 text-sm font-semibold font-mono text-slate-900 dark:text-slate-100">
                      <span>@{c.login}</span>
                      <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
                        ·
                      </span>
                      <span
                        className={`text-xs font-sans font-medium ${
                          online
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {online ? 'В сети (P2P)' : 'Офлайн (Store-and-Forward)'}
                      </span>
                      {c.status === 'pending_outgoing' && (
                        <>
                          <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
                            ·
                          </span>
                          <span className="text-xs font-sans text-amber-700 dark:text-amber-400">
                            Запрос отправлен
                          </span>
                        </>
                      )}
                    </div>
                    <div className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate">
                      DID: {shortHash(c.did, 14, 8)} · X25519: {shortHash(c.x25519PublicKey, 10, 6)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onOpenChat(c.did)}
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:opacity-90 text-xs font-medium whitespace-nowrap"
                    >
                      <MessageSquare className="w-3.5 h-3.5" />
                      <span>Открыть чат</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => controller.blockContact(c.did)}
                      className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-red-600 dark:hover:text-red-400"
                      title="Заблокировать"
                    >
                      <Ban className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Auto-discovered network peers */}
      {discovered.length > 0 && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">
            Обнаруженные активные узлы в сети ({discovered.length})
          </h2>
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {discovered.map((card) => {
              const alreadyContact = contacts.some((c) => c.did === card.did);
              return (
                <div
                  key={card.did}
                  className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium font-mono">@{card.login}</div>
                    <div className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate">
                      {card.did}
                    </div>
                  </div>
                  {alreadyContact ? (
                    <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      Уже в контактах
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleAddContact(card)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium whitespace-nowrap shrink-0"
                    >
                      <UserPlus className="w-3.5 h-3.5" />
                      <span>Добавить</span>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {blocked.length > 0 && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">
            Заблокированные контакты ({blocked.length})
          </h2>
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {blocked.map((c) => (
              <div key={c.did} className="py-2.5 flex items-center justify-between gap-3">
                <span className="text-sm font-mono text-slate-600 dark:text-slate-400">
                  @{c.login}
                </span>
                <button
                  type="button"
                  onClick={() => controller.unblockContact(c.did)}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  Разблокировать
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
