/**
 * The Updater port backed by electron-updater, which reads the GitHub Releases feed named in
 * resources/app-update.yml (written by electron-builder from package.json's build.publish).
 */
import electronUpdater, { type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from 'electron-updater';
import type { Updater, UpdaterEvent } from './updates.ts';

export const electronUpdaterAdapter = ({ installs }: { readonly installs: boolean }): Updater => {
  // electron-updater is CommonJS with getter exports, which ESM named imports can't see.
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = installs;
  autoUpdater.autoInstallOnAppQuit = installs;
  return {
    check: async () => {
      await autoUpdater.checkForUpdates();
    },
    install: () => autoUpdater.quitAndInstall(),
    onEvent: (listener: (event: UpdaterEvent) => void) => {
      autoUpdater.on('checking-for-update', () => listener({ kind: 'checking' }));
      autoUpdater.on('update-available', (info: UpdateInfo) => listener({ kind: 'available', version: info.version }));
      autoUpdater.on('update-not-available', () => listener({ kind: 'not-available' }));
      autoUpdater.on('download-progress', (progress: ProgressInfo) => listener({ kind: 'progress', percent: progress.percent }));
      autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => listener({ kind: 'downloaded', version: event.version }));
      autoUpdater.on('error', (error: Error) => listener({ kind: 'error', message: error.message }));
    },
  };
};
