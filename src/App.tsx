/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Menu } from 'lucide-react';
import { MixNodeController } from './modules/MixNodeController';
import type { NodeTelemetrySnapshot, ScreenId } from './modules/types';
import { AuthView } from './modules/ui/AuthView';
import { BackupsView } from './modules/ui/BackupsView';
import { ChatsView } from './modules/ui/ChatsView';
import { ContactsView } from './modules/ui/ContactsView';
import { GroupsView } from './modules/ui/GroupsView';
import { NetworkView } from './modules/ui/NetworkView';
import { NodeInfoView } from './modules/ui/NodeInfoView';
import { PrivacyView } from './modules/ui/PrivacyView';
import { OfflineIndicator, PWAInstallButton } from './modules/ui/PWAInstallButton';
import { SecurityView } from './modules/ui/SecurityView';
import { SidebarNav } from './modules/ui/SidebarNav';
import { StorageView } from './modules/ui/StorageView';

const SCREEN_TITLES: Record<ScreenId, string> = {
  contacts: 'Контакты и поиск в DHT',
  chats: 'Личные чаты и передача файлов',
  groups: 'Приватные групповые чаты',
  storage: 'Управление распределённым хранилищем',
  node: 'Состояние собственного сетевого узла',
  network: 'Настройки P2P-сети',
  privacy: 'Приватность и защита метаданных',
  security: 'Настройки безопасности',
  backups: 'Управление резервными копиями',
};

function resolveSlotFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('slot') || 'primary';
}

export default function App() {
  const controller = useMemo(() => new MixNodeController(resolveSlotFromUrl()), []);
  const [, setTick] = useState(0);
  const [ready, setReady] = useState(false);
  const [activeScreen, setActiveScreen] = useState<ScreenId>('contacts');
  const [selectedContactDid, setSelectedContactDid] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [telemetry, setTelemetry] = useState<NodeTelemetrySnapshot | null>(null);

  useEffect(() => {
    const unsub = controller.subscribe(() => {
      setTick((t) => t + 1);
    });
    controller.init().then(() => {
      setReady(true);
    });
    return () => {
      unsub();
    };
  }, [controller]);

  useEffect(() => {
    if (!controller.isUnlocked()) return;
    let active = true;
    const refreshTelemetry = async () => {
      const snap = await controller.getTelemetrySnapshot();
      if (active) setTelemetry(snap);
    };
    refreshTelemetry().catch(() => {});
    const timer = setInterval(() => {
      refreshTelemetry().catch(() => {});
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [controller, controller.isUnlocked()]);

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-sm text-slate-500">
        Инициализация локального криптографического хранилища...
      </div>
    );
  }

  if (!controller.isUnlocked()) {
    return (
      <AuthView
        controller={controller}
        hasExistingAccount={controller.hasExistingAccount()}
        existingLogin={controller.getExistingLogin()}
      />
    );
  }

  const session = controller.getSession()!;
  const settings = controller.getSettings();
  const contacts = controller.getContacts();
  const groups = controller.getGroups();
  const allMessages = controller.getAllMessages();

  const pendingRequestsCount = contacts.filter(
    (c) => c.status === 'pending_incoming'
  ).length;
  const unreadCount = allMessages.filter(
    (m) => m.senderDid !== session.secret.did && m.status !== 'read'
  ).length;

  const secondNodeHref = `?slot=node-${Math.random().toString(36).slice(2, 6)}`;

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <SidebarNav
        activeScreen={activeScreen}
        onSelect={setActiveScreen}
        login={session.secret.login}
        did={session.secret.did}
        unreadCount={unreadCount}
        pendingRequestsCount={pendingRequestsCount}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
        onLock={() => controller.lockAccount()}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Clean 3-zone top bar */}
        <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-4 sm:px-6 py-3.5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="md:hidden p-2 rounded-lg border border-slate-200 dark:border-slate-700"
              aria-label="Открыть меню"
            >
              <Menu className="w-4 h-4" />
            </button>
            <h1 className="text-sm sm:text-base font-semibold truncate">
              {SCREEN_TITLES[activeScreen]}
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <PWAInstallButton variant="compact" />
            <a
              href={secondNodeHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium whitespace-nowrap shrink-0 transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Открыть второй узел</span>
            </a>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 max-w-6xl w-full mx-auto">
          {activeScreen === 'contacts' && (
            <ContactsView
              controller={controller}
              contacts={contacts}
              onOpenChat={(did) => {
                setSelectedContactDid(did);
                setActiveScreen('chats');
              }}
            />
          )}

          {activeScreen === 'chats' && (
            <ChatsView
              controller={controller}
              contacts={contacts}
              selectedContactDid={selectedContactDid}
              onSelectContact={setSelectedContactDid}
            />
          )}

          {activeScreen === 'groups' && (
            <GroupsView
              controller={controller}
              groups={groups}
              contacts={contacts}
            />
          )}

          {activeScreen === 'storage' && telemetry && (
            <StorageView
              controller={controller}
              settings={settings}
              telemetry={telemetry}
            />
          )}

          {activeScreen === 'node' && telemetry && (
            <NodeInfoView controller={controller} telemetry={telemetry} />
          )}

          {activeScreen === 'network' && telemetry && (
            <NetworkView
              controller={controller}
              settings={settings}
              telemetry={telemetry}
            />
          )}

          {activeScreen === 'privacy' && (
            <PrivacyView controller={controller} settings={settings} />
          )}

          {activeScreen === 'security' && telemetry && (
            <SecurityView
              controller={controller}
              settings={settings}
              telemetry={telemetry}
            />
          )}

          {activeScreen === 'backups' && <BackupsView controller={controller} />}
        </main>
      </div>
      <OfflineIndicator />
    </div>
  );
}
