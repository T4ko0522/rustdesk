import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationCommandOptionType } from 'discord.js';
import type { InteractionEditReplyOptions, InteractionReplyOptions, InteractionDeferReplyOptions } from 'discord.js';
import { AccessError, createAccessService, createFileAllowedUsersStore } from '../src/access.js';
import type { AccessService, AllowedUsersStore } from '../src/access.js';
import { createAddCommand, createInteractionHandler } from '../src/discord.js';
import type { CommandInteraction } from '../src/discord.js';
import { createCredentialService } from '../src/service.js';

const guildId = '222222222222222222';
const initialUser = '111111111111111111';
const adminUser = '333333333333333333';
const newUser = '444444444444444444';
const anotherUser = '555555555555555555';
const admin = { userId: adminUser, guildId };
const config = { guildId, allowedUserIds: [initialUser], adminUserIds: [adminUser] };

function memoryStore(): AllowedUsersStore & { saved: readonly string[][] } {
  const saved: string[][] = [];
  return { saved, load: async () => [], save: async ids => { saved.push([...ids]); } };
}

async function withDirectory(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'rustdesk-access-'));
  try { await action(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('only configured administrators in the configured guild can grant access', async () => {
  const store = memoryStore();
  const access = await createAccessService(config, store);
  assert.equal(access.canManage(admin), true);
  assert.equal(access.authorize(admin), false);
  for (const identity of [null, {}, { userId: initialUser, guildId }, { userId: newUser, guildId }, { ...admin, guildId: anotherUser }, { ...admin, guildId: null }]) {
    assert.equal(access.canManage(identity), false);
    await assert.rejects(access.add(identity, newUser), { code: 'FORBIDDEN' });
  }
  assert.equal(store.saved.length, 0);
  assert.equal(await access.add(admin, newUser), 'added');
  assert.equal(access.canManage({ userId: newUser, guildId }), false);
  await assert.rejects(access.add({ userId: newUser, guildId }, anotherUser), { code: 'FORBIDDEN' });
  assert.equal(store.saved.length, 1);
});

test('new grants immediately authorize get and rotate without granting management', async () => {
  const access = await createAccessService(config, memoryStore());
  const identity = { userId: newUser, guildId };
  const credentials = { id: 'mac_01', password: 'abc123' };
  const calls: string[] = [];
  const service = createCredentialService({ access, cooldownMs: 0, adapter: {
    readCredentials: async () => { calls.push('read'); return credentials; },
    rotateCredentials: async () => { calls.push('rotate'); return credentials; },
  } });
  await assert.rejects(service.get(identity), { code: 'FORBIDDEN' });
  await assert.rejects(service.rotate(identity), { code: 'FORBIDDEN' });
  await access.add(admin, newUser);
  assert.deepEqual(await service.get(identity), credentials);
  assert.deepEqual(await service.rotate(identity), credentials);
  assert.deepEqual(calls, ['read', 'rotate']);
  assert.equal(access.canManage(identity), false);
  assert.equal(service.authorize({ ...identity, guildId: anotherUser }), false);
  assert.equal(service.authorize({ ...identity, guildId: null }), false);
});

test('concurrent grants and duplicates are serialized without lost updates', async () => {
  const store = memoryStore();
  const access = await createAccessService(config, store);
  assert.deepEqual(await Promise.all([
    access.add(admin, newUser), access.add(admin, anotherUser), access.add(admin, newUser),
  ]), ['added', 'added', 'exists']);
  assert.deepEqual(store.saved, [[newUser], [newUser, anotherUser]]);
  assert.equal(await access.add(admin, initialUser), 'exists');
  assert.equal(store.saved.length, 2);
});

test('permissions remain denied until persistence completes successfully', async () => {
  let finish: (() => void) | undefined;
  const saving = new Promise<void>(resolve => { finish = resolve; });
  const access = await createAccessService(config, { load: async () => [], save: () => saving });
  const pending = access.add(admin, newUser);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(access.authorize({ userId: newUser, guildId }), false);
  assert.ok(finish); finish();
  await pending;
  assert.equal(access.authorize({ userId: newUser, guildId }), true);
});

test('failed persistence never grants access and does not poison later requests', async () => {
  let attempts = 0;
  const access = await createAccessService(config, { load: async () => [], save: async () => {
    if (attempts++ === 0) throw new Error('secret-file-path');
  } });
  await assert.rejects(access.add(admin, newUser), error => error instanceof AccessError && error.code === 'SAVE_FAILED' && !String(error.stack).includes('secret-file-path') && error.cause === undefined);
  assert.equal(access.authorize({ userId: newUser, guildId }), false);
  assert.equal(await access.add(admin, anotherUser), 'added');
  assert.equal(access.authorize({ userId: anotherUser, guildId }), true);
  assert.equal(access.authorize({ userId: newUser, guildId }), false);
});

test('invalid target IDs are rejected before persistence', async () => {
  const store = memoryStore();
  const access = await createAccessService(config, store);
  for (const userId of [null, undefined, 42, 'invalid', '']) {
    await assert.rejects(access.add(admin, userId), { code: 'INVALID_USER' });
  }
  assert.equal(store.saved.length, 0);
});

test('file store restores grants with private permissions and excludes environment grants', async () => {
  await withDirectory(async directory => {
    const path = join(directory, 'private', 'allowed-users.json');
    const store = createFileAllowedUsersStore({ path, guildId });
    const access = await createAccessService(config, store);
    assert.equal(await access.add(admin, initialUser), 'exists');
    await assert.rejects(stat(path), { code: 'ENOENT' });
    await access.add(admin, newUser);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { guildId, userIds: [newUser] });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'private'))).mode & 0o777, 0o700);
    const restored = await createAccessService({ ...config, allowedUserIds: [anotherUser] }, createFileAllowedUsersStore({ path, guildId }));
    assert.equal(restored.authorize({ userId: newUser, guildId }), true);
    assert.equal(restored.authorize({ userId: initialUser, guildId }), false);
    assert.equal(restored.canManage({ userId: newUser, guildId }), false);
    assert.equal(await restored.add(admin, newUser), 'exists');
  });
});

test('malformed files, mismatched guilds and non-ENOENT read failures stop startup', async () => {
  await withDirectory(async directory => {
    const path = join(directory, 'users.json');
    const store = createFileAllowedUsersStore({ path, guildId });
    for (const content of ['not json secret', 'null', '[]', '{}', JSON.stringify({ guildId: anotherUser, userIds: [newUser] }), JSON.stringify({ guildId, userIds: ['invalid'] }), JSON.stringify({ guildId, userIds: newUser })]) {
      await writeFile(path, content);
      await assert.rejects(createAccessService(config, store), { message: 'Invalid access permissions file.' });
    }
    await rm(path);
    await mkdir(path);
    await assert.rejects(store.load(), { message: 'Unable to load access permissions.' });
    await assert.rejects(store.save([newUser]), { message: 'Unable to save access permissions.' });
  });
});

test('add command registers a required Discord user option', () => {
  const command = createAddCommand().toJSON();
  assert.equal(command.name, 'add');
  assert.equal(command.options?.length, 1);
  const option = command.options?.[0];
  assert.ok(option);
  assert.equal(option.type, ApplicationCommandOptionType.User);
  assert.equal(option.name, 'user');
  assert.equal(option.required, true);
});

function addInteraction(actor: { userId: string; guildId: string | null }, target: string = newUser) {
  const replies: InteractionReplyOptions[] = [];
  const edits: InteractionEditReplyOptions[] = [];
  const defers: InteractionDeferReplyOptions[] = [];
  let selected = false;
  const interaction: CommandInteraction = {
    isChatInputCommand: () => true, commandName: 'add', user: { id: actor.userId }, guildId: actor.guildId,
    options: {
      getString: () => assert.fail('unexpected action selection'),
      getUser: (name, required) => { assert.equal(name, 'user'); assert.equal(required, true); selected = true; return { id: target }; },
    },
    reply: async value => { replies.push(value); }, editReply: async value => { edits.push(value); },
    deferReply: async value => { defers.push(value); }, deleteReply: () => assert.fail('unexpected deletion'),
  };
  return { interaction, replies, edits, defers, selected: () => selected };
}

function addHandler(access: AccessService) {
  return createInteractionHandler({ access, service: {
    authorize: () => assert.fail('RustDesk authorization touched'),
    get: () => assert.fail('RustDesk adapter touched'), rotate: () => assert.fail('RustDesk adapter touched'),
  } });
}

test('add handler replies privately and idempotently for configured administrators', async () => {
  const store = memoryStore();
  const access = await createAccessService(config, store);
  const handler = addHandler(access);
  for (const message of ['指定したユーザーに RustDesk の実行権限を追加しました。', '指定したユーザーにはすでに RustDesk の実行権限があります。']) {
    const capture = addInteraction(admin);
    await handler(capture.interaction);
    assert.deepEqual(capture.defers, [{ flags: 64 }]);
    assert.deepEqual(capture.edits, [{ content: message, allowedMentions: { parse: [] } }]);
    assert.equal(capture.replies.length, 0);
    assert.equal(capture.selected(), true);
  }
  assert.deepEqual(store.saved, [[newUser]]);
});

test('add handler denies ordinary users, new grantees, wrong guild and DMs before selecting or saving', async () => {
  const store = memoryStore();
  const access = await createAccessService(config, store);
  await access.add(admin, newUser);
  const handler = addHandler(access);
  for (const actor of [{ userId: initialUser, guildId }, { userId: newUser, guildId }, { ...admin, guildId: anotherUser }, { ...admin, guildId: null }]) {
    const capture = addInteraction(actor, anotherUser);
    Object.assign(capture.interaction, { memberPermissions: { has: () => true } });
    await handler(capture.interaction);
    assert.equal(capture.selected(), false);
    assert.equal(capture.defers.length, 0);
    assert.deepEqual(capture.replies, [{ content: 'この操作は許可されていません。', flags: 64, allowedMentions: { parse: [] } }]);
  }
  assert.equal(store.saved.length, 1);
});

test('add handler sanitizes persistence and user selection errors without granting access', async () => {
  const access = await createAccessService(config, { load: async () => [], save: async () => { throw Error('secret-file-path'); } });
  const capture = addInteraction(admin);
  await addHandler(access)(capture.interaction);
  assert.deepEqual(capture.edits, [{ content: '実行権限を保存できませんでした。時間をおいて再試行してください。', allowedMentions: { parse: [] } }]);
  assert.equal(access.authorize({ userId: newUser, guildId }), false);
  const malformed = addInteraction(admin, 'invalid');
  await addHandler(access)(malformed.interaction);
  assert.deepEqual(malformed.replies, [{ content: '処理に失敗しました。時間をおいて再試行してください。', flags: 64, allowedMentions: { parse: [] } }]);
  assert.equal(malformed.defers.length, 0);
});
