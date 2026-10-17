import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';
import { filePathSchema, identitySchema, snowflakeSchema, userIdsSchema } from './schemas.js';

const storedUsersSchema = z.object({ guildId: snowflakeSchema, userIds: userIdsSchema });
const fileOptionsSchema = z.object({ path: filePathSchema, guildId: snowflakeSchema });
const accessOptionsSchema = z.object({
  guildId: snowflakeSchema,
  allowedUserIds: z.array(snowflakeSchema).nonempty(),
  adminUserIds: z.array(snowflakeSchema).nonempty(),
});
const storeSchema = z.object({
  load: z.function({ input: [], output: z.promise(userIdsSchema) }),
  save: z.function({ input: [userIdsSchema], output: z.promise(z.void()) }),
});
export type AllowedUsersStore = z.infer<typeof storeSchema>;
export type AddUserResult = 'added' | 'exists';
export interface AccessService {
  authorize(identity: unknown): boolean;
  canManage(identity: unknown): boolean;
  add(identity: unknown, userId: unknown): Promise<AddUserResult>;
}

const accessMessages = {
  FORBIDDEN: 'この操作は許可されていません。',
  INVALID_USER: '指定したユーザーが無効です。',
  SAVE_FAILED: '実行権限を保存できませんでした。時間をおいて再試行してください。',
} as const;
export class AccessError extends Error {
  constructor(readonly code: keyof typeof accessMessages) {
    super(accessMessages[code]);
    this.name = 'AccessError';
  }
}

export function createFileAllowedUsersStore(options: unknown): AllowedUsersStore {
  const parsed = fileOptionsSchema.safeParse(options);
  if (!parsed.success) throw new Error('Invalid access file configuration.');
  const path = resolve(parsed.data.path);
  const guildId = parsed.data.guildId;
  return {
    async load() {
      let content: string;
      try { content = await readFile(path, 'utf8'); }
      catch (error) {
        if (z.object({ code: z.literal('ENOENT') }).safeParse(error).success) return [];
        throw new Error('Unable to load access permissions.');
      }
      try {
        const value: unknown = JSON.parse(content);
        return storedUsersSchema.refine(data => data.guildId === guildId).parse(value).userIds;
      } catch { throw new Error('Invalid access permissions file.'); }
    },
    async save(userIds) {
      try {
        const value = storedUsersSchema.parse({ guildId, userIds });
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFileAtomic(path, JSON.stringify(value) + '\n', { mode: 0o600 });
      } catch { throw new Error('Unable to save access permissions.'); }
    },
  };
}

export async function createAccessService(options: unknown, persistence: AllowedUsersStore): Promise<AccessService> {
  const parsed = accessOptionsSchema.safeParse(options);
  if (!parsed.success) throw new Error('Invalid access configuration.');
  const store = storeSchema.safeParse(persistence);
  if (!store.success) throw new Error('Invalid access store.');
  const storage = store.data;
  const { guildId, allowedUserIds, adminUserIds } = parsed.data;
  const initial = new Set(allowedUserIds);
  const admins = new Set(adminUserIds);
  let added = new Set(await storage.load());
  let queue = Promise.resolve();

  function matches(identity: unknown, userIds: ReadonlySet<string>): boolean {
    const parsedIdentity = identitySchema.safeParse(identity);
    return parsedIdentity.success && parsedIdentity.data.guildId === guildId && userIds.has(parsedIdentity.data.userId);
  }
  function authorize(identity: unknown): boolean {
    return matches(identity, initial) || matches(identity, added);
  }
  function canManage(identity: unknown): boolean { return matches(identity, admins); }

  async function add(identity: unknown, userId: unknown): Promise<AddUserResult> {
    if (!canManage(identity)) throw new AccessError('FORBIDDEN');
    const target = snowflakeSchema.safeParse(userId);
    if (!target.success) throw new AccessError('INVALID_USER');
    const operation = queue.then(async (): Promise<AddUserResult> => {
      if (initial.has(target.data) || added.has(target.data)) return 'exists';
      const next = new Set(added).add(target.data);
      try { await storage.save([...next]); }
      catch { throw new AccessError('SAVE_FAILED'); }
      added = next;
      return 'added';
    });
    queue = operation.then(() => {}, () => {});
    return operation;
  }
  return Object.freeze({ authorize, canManage, add });
}
