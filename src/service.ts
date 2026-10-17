import { credentialsSchema, identitySchema, serviceOptionsSchema } from './schemas.js';
import type { Credentials, CredentialOperation } from './schemas.js';

const messages = {
  FORBIDDEN: 'この操作は許可されていません。',
  BUSY: '別のリクエストを処理中です。',
  COOLDOWN: '少し待ってから再試行してください。',
  BACKEND_FAILED: 'RustDesk の認証情報を取得または更新できませんでした。',
} as const;

export class CredentialError extends Error {
  readonly code: keyof typeof messages;
  constructor(code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'CredentialError';
    this.code = code;
  }
}

export interface CredentialService {
  authorize(identity: unknown): boolean;
  get(identity: unknown): Promise<Credentials>;
  rotate(identity: unknown): Promise<Credentials>;
}

export function createCredentialService(options: unknown): CredentialService {
  const result = serviceOptionsSchema.safeParse(options);
  if (!result.success) throw new Error('Invalid credential service configuration.');
  const { adapter, access, cooldownMs } = result.data;
  let busy = false;
  let lastStarted = -Infinity;

  function authorize(identity: unknown): boolean {
    const parsed = identitySchema.safeParse(identity);
    return parsed.success && access.authorize(parsed.data);
  }

  async function execute(identity: unknown, operation: CredentialOperation): Promise<Credentials> {
    if (!authorize(identity)) throw new CredentialError('FORBIDDEN');
    if (busy) throw new CredentialError('BUSY');
    if (operation === 'rotate' && performance.now() - lastStarted < cooldownMs) throw new CredentialError('COOLDOWN');
    busy = true;
    if (operation === 'rotate') lastStarted = performance.now();
    try {
      const result = operation === 'rotate' ? await adapter.rotateCredentials() : await adapter.readCredentials();
      return credentialsSchema.parse(result);
    } catch {
      throw new CredentialError('BACKEND_FAILED');
    } finally {
      busy = false;
    }
  }
  return Object.freeze({
    authorize,
    get: (identity: unknown) => execute(identity, 'read'),
    rotate: (identity: unknown) => execute(identity, 'rotate'),
  });
}
