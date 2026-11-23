import React from 'react';
import {
  Activity,
  Archive,
  EyeOff,
  HardDrive,
  Lock,
  MessageSquare,
  Network,
  Shield,
  Users,
  UserSearch,
} from 'lucide-react';
import type { ScreenId } from '../types';

interface SidebarNavProps {
  activeScreen: ScreenId;
  onSelect: (screen: ScreenId) => void;
  login: string;
  did: string;
  unreadCount: number;
  pendingRequestsCount: number;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onLock: () => void;
}

const NAV_GROUPS: Array<{
  title: string;
  items: Array<{ id: ScreenId; label: string; icon: React.ComponentType<{ className?: string }> }>;
}> = [
  {
    title: 'Коммуникация',
    items: [
      { id: 'contacts', label: 'Контакты и поиск', icon: UserSearch },
      { id: 'chats', label: 'Личные чаты', icon: MessageSquare },
      { id: 'groups', label: 'Групповые чаты', icon: Users },
    ],
  },
  {
    title: 'Узел и хранилище',
    items: [
      { id: 'storage', label: 'Хранилище блоков', icon: HardDrive },
      { id: 'node', label: 'Состояние узла', icon: Activity },
    ],
  },
  {
    title: 'Параметры и защита',
    items: [
      { id: 'network', label: 'Сеть P2P', icon: Network },
      { id: 'privacy', label: 'Приватность', icon: EyeOff },
      { id: 'security', label: 'Безопасность', icon: Shield },
      { id: 'backups', label: 'Резервные копии', icon: Archive },
    ],
  },
];

export const SidebarNav: React.FC<SidebarNavProps> = ({
  activeScreen,
  onSelect,
  login,
  did,
  unreadCount,
  pendingRequestsCount,
  mobileOpen,
  onCloseMobile,
  onLock,
}) => {
  const content = (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 w-64">
      <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
        <div className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100">
          MiX
        </div>
        <div className="mt-2 text-xs text-slate-600 dark:text-slate-400 truncate font-mono">
          @{login}
        </div>
        <div className="text-[11px] text-slate-400 dark:text-slate-500 truncate font-mono">
          {did}
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        {NAV_GROUPS.map((group) => (
          <div key={group.title}>
            <div className="px-3 mb-2 text-[11px] font-semibold text-slate-400 dark:text-slate-500">
              {group.title}
            </div>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = activeScreen === item.id;
                const badge =
                  item.id === 'contacts' && pendingRequestsCount > 0
                    ? pendingRequestsCount
                    : item.id === 'chats' && unreadCount > 0
                      ? unreadCount
                      : 0;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      onSelect(item.id);
                      onCloseMobile();
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                      isActive
                        ? 'bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-300'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/70 hover:text-slate-900 dark:hover:text-slate-100'
                    }`}
                  >
                    <span className="flex items-center gap-2.5 truncate">
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </span>
                    {badge > 0 && (
                      <span className="text-xs font-mono tabular-nums text-teal-700 dark:text-teal-300">
                        {badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="p-3 border-t border-slate-200 dark:border-slate-800">
        <button
          type="button"
          onClick={onLock}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
        >
          <Lock className="w-3.5 h-3.5" />
          <span>Заблокировать ключи</span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden md:block shrink-0">{content}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <div className="relative z-10">{content}</div>
          <div
            className="flex-1 bg-slate-950/40"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
        </div>
      )}
    </>
  );
};
