import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
const valid={DISCORD_TOKEN:'secret-token',DISCORD_GUILD_ID:'222222222222222222',DISCORD_ALLOWED_USER_IDS:'111111111111111111, 333333333333333333',DISCORD_ADMIN_USER_IDS:'444444444444444444',RUSTDESK_SOCKET_PATH:'/tmp/RustDesk-501/ipc'};
test('requires configured administrators and rejects invalid persistence paths',()=>{
 assert.throws(()=>loadConfig({...valid,DISCORD_ADMIN_USER_IDS:undefined}));
 for(const patch of [{DISCORD_ADMIN_USER_IDS:''},{DISCORD_ADMIN_USER_IDS:'invalid'},{ALLOWED_USERS_FILE:''},{ALLOWED_USERS_FILE:'data/users\0.json'}]) {
  assert.throws(()=>loadConfig({...valid,DISCORD_ADMIN_USER_IDS:'444444444444444444',...patch}));
 }
});
test('loads explicit config, deduplicates IDs and defaults cooldown',()=>{
 const config=loadConfig({...valid,DISCORD_ALLOWED_USER_IDS:valid.DISCORD_ALLOWED_USER_IDS+',111111111111111111'});
 assert.equal(config.cooldownMs,30000);assert.equal(config.socketPath,valid.RUSTDESK_SOCKET_PATH);assert.equal(config.allowedUserIds.length,2);assert.ok(Object.isFrozen(config.allowedUserIds));
});
test('admin IDs are trimmed and deduplicated independently and persistence paths may be relative or absolute',()=>{
 const config=loadConfig({...valid,DISCORD_ADMIN_USER_IDS:' 444444444444444444,444444444444444444 '});
 assert.deepEqual(config.adminUserIds,['444444444444444444']);
 assert.ok(Object.isFrozen(config.adminUserIds));
 assert.equal(config.allowedUsersFile,'data/allowed-users.json');
 for(const path of ['custom/users.json','/tmp/private-users.json']) {
  assert.equal(loadConfig({...valid,ALLOWED_USERS_FILE:path}).allowedUsersFile,path);
 }
});
test('rejects NUL socket paths and non-object environment input safely',()=>{
 for (const env of [null, 42, {...valid,RUSTDESK_SOCKET_PATH:'/tmp/ipc\0'}]) {
  assert.throws(()=>loadConfig(env),{message:'Invalid bot configuration. Check the required environment variables.'});
 }
});
test('rejects missing credentials, invalid IDs and relative or missing socket',()=>{
 for(const patch of [{DISCORD_TOKEN:''},{DISCORD_GUILD_ID:'abc'},{DISCORD_ALLOWED_USER_IDS:''},{DISCORD_ALLOWED_USER_IDS:'111111111111111111,invalid'},{RUSTDESK_SOCKET_PATH:''},{RUSTDESK_SOCKET_PATH:'ipc'},{COOLDOWN_MS:'-1'},{COOLDOWN_MS:'Infinity'},{COOLDOWN_MS:''},{COOLDOWN_MS:'9007199254740992'}]){
  assert.throws(()=>loadConfig({...valid,...patch}),error=>error instanceof Error && !error.message.includes('secret-token'));
 }
});
