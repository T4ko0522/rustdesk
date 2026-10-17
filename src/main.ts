import { loadConfig } from './config.js';
import { createCredentialService } from './service.js';
import { createRustDeskAdapter } from './rustdesk.js';
import { startDiscordBot } from './discord.js';
import { createAccessService, createFileAllowedUsersStore } from './access.js';

try {
  const config = loadConfig();
  const store = createFileAllowedUsersStore({ path: config.allowedUsersFile, guildId: config.guildId });
  const access = await createAccessService({
    guildId: config.guildId,
    allowedUserIds: config.allowedUserIds,
    adminUserIds: config.adminUserIds,
  }, store);
  const adapter = createRustDeskAdapter({ socketPath: config.socketPath });
  const service = createCredentialService({
    adapter,
    access,
    cooldownMs: config.cooldownMs,
  });
  const client = await startDiscordBot({ token: config.token, guildId: config.guildId, service, access });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      client.destroy();
    });
  }
} catch {
  console.error('Bot startup failed. Check local configuration and RustDesk availability.');
  process.exitCode = 1;
}
