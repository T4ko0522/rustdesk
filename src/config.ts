import { z } from 'zod';
import { cooldownSchema, filePathSchema, snowflakeSchema, socketPathSchema, userIdsEnvironmentSchema } from './schemas.js';

const environmentSchema = z.object({
  DISCORD_TOKEN: z.string().trim().min(1),
  DISCORD_GUILD_ID: z.string().trim().pipe(snowflakeSchema),
  DISCORD_ALLOWED_USER_IDS: userIdsEnvironmentSchema,
  DISCORD_ADMIN_USER_IDS: userIdsEnvironmentSchema,
  ALLOWED_USERS_FILE: z.string().trim().default('data/allowed-users.json').pipe(filePathSchema),
  RUSTDESK_SOCKET_PATH: z.string().trim().pipe(socketPathSchema),
  COOLDOWN_MS: z.string().regex(/^\d+$/).default('30000').transform(Number).pipe(cooldownSchema),
}).transform(env => ({
  token: env.DISCORD_TOKEN,
  guildId: env.DISCORD_GUILD_ID,
  allowedUserIds: env.DISCORD_ALLOWED_USER_IDS,
  adminUserIds: env.DISCORD_ADMIN_USER_IDS,
  allowedUsersFile: env.ALLOWED_USERS_FILE,
  socketPath: env.RUSTDESK_SOCKET_PATH,
  cooldownMs: env.COOLDOWN_MS,
})).readonly();

export type BotConfig = z.infer<typeof environmentSchema>;

export function loadConfig(env: unknown = process.env): BotConfig {
  const result = environmentSchema.safeParse(env);
  if (!result.success) throw new Error('Invalid bot configuration. Check the required environment variables.');
  return result.data;
}
