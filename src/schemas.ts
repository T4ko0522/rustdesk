import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const snowflakeSchema = z.string().regex(/^[1-9]\d{16,19}$/);
export const userIdsSchema = z.array(snowflakeSchema).transform(ids => [...new Set(ids)]).readonly();
export const userIdsEnvironmentSchema = z.string()
  .transform(value => value.split(',').map(id => id.trim()).filter(Boolean))
  .pipe(z.array(snowflakeSchema).nonempty()).transform(ids => [...new Set(ids)]).readonly();
export const filePathSchema = z.string().min(1).refine(value => !value.includes('\0'));
export const socketPathSchema = z.string().min(1).refine(isAbsolute).refine(value => !value.includes('\0'));
export const cooldownSchema = z.number().int().nonnegative();
export const rustDeskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const passwordSchema = z.string().regex(/^[A-Za-z0-9]{6,64}$/);
export const credentialsSchema = z.object({ id: rustDeskIdSchema, password: passwordSchema });
export type Credentials = z.infer<typeof credentialsSchema>;

// Adapter results remain unknown until parsed at the service boundary.
const credentialMethodSchema = z.function({ input: [], output: z.promise(z.unknown()) });
export const adapterSchema = z.object({
  readCredentials: credentialMethodSchema,
  rotateCredentials: credentialMethodSchema,
});
export const credentialOperationSchema = z.enum(['read', 'rotate']);
export type CredentialOperation = z.infer<typeof credentialOperationSchema>;
export const commandActionSchema = z.enum(['rotate']).nullable().transform(action => action ?? 'read' as const);
export type CredentialAdapter = z.infer<typeof adapterSchema>;
export const serviceOptionsSchema = z.object({
  adapter: adapterSchema,
  access: z.object({ authorize: z.function({ input: [z.unknown()], output: z.boolean() }) }),
  cooldownMs: cooldownSchema,
});
export const identitySchema = z.object({ userId: snowflakeSchema, guildId: snowflakeSchema });
export const discordUserSchema = z.object({ id: snowflakeSchema });
export const adapterOptionsSchema = z.object({
  socketPath: socketPathSchema,
  timeoutMs: z.number().positive().max(2_147_483_647).default(5000),
});
export const configResponseSchema = z.object({ t: z.literal('Config'), c: z.tuple([z.string(), z.string()]) });
export const optionsResponseSchema = z.object({
  t: z.literal('Options'),
  c: z.object({
    'verification-method': z.enum(['', 'use-temporary-password', 'use-both-passwords']).optional(),
    'approve-mode': z.enum(['', 'password', 'password-click']).optional(),
  }),
});
export const ipcRequestSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('Options'), c: z.null() }),
  z.object({ t: z.literal('Config'), c: z.tuple([z.string(), z.string().nullable()]) }),
]);
export type IpcRequest = z.infer<typeof ipcRequestSchema>;
