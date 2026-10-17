import test from 'node:test';
import assert from 'node:assert/strict';
import { createCredentialService, CredentialError } from '../src/service.js';
import { createInteractionHandler, createRustDeskCommand } from '../src/discord.js';
import type { CommandInteraction } from '../src/discord.js';
import { identitySchema } from '../src/schemas.js';
import type { Credentials } from '../src/schemas.js';
import type { AccessService } from '../src/access.js';
import { ApplicationCommandOptionType } from 'discord.js';
import type { InteractionEditReplyOptions, InteractionReplyOptions, InteractionDeferReplyOptions } from 'discord.js';
const identity = {userId:'111111111111111111', guildId:'222222222222222222'};
const access: AccessService={
 authorize:value=>{
  const parsed=identitySchema.safeParse(value);
  return parsed.success && parsed.data.guildId===identity.guildId && [identity.userId,'333333333333333333'].includes(parsed.data.userId);
 },
 canManage:()=>false,
 add:()=>assert.fail('unexpected grant'),
};
const options = {access,cooldownMs:0};

function mockInteraction(action: string | null) {
 const replies: InteractionReplyOptions[]=[];
 const edits: InteractionEditReplyOptions[]=[];
 const defers: InteractionDeferReplyOptions[]=[];
 const interaction: CommandInteraction={
  isChatInputCommand:()=>true, commandName:'rustdesk', user:{id:identity.userId}, guildId:identity.guildId,
  options:{getString:name=>{assert.equal(name,'action');return action;},getUser:()=>assert.fail('unexpected getUser')},
  reply:async value=>{replies.push(value);}, editReply:async value=>{edits.push(value);},
  deferReply:async value=>{defers.push(value);}, deleteReply:async()=>{},
 };
 return {interaction,replies,edits,defers};
}

test('command registers an optional action string with only the rotate choice',()=>{
 const command=createRustDeskCommand().toJSON();
 assert.equal(command.name,'rustdesk');
 assert.ok(command.options);
 assert.equal(command.options.length,1);
 const [action]=command.options;
 assert.ok(action?.type===ApplicationCommandOptionType.String);
 assert.equal(action.name,'action');
 assert.equal(action.required,false);
 assert.deepEqual(action.choices?.map(({name,value})=>({name,value})),[{name:'rotate',value:'rotate'}]);
});

test('Discord defaults to reading and routes only the rotate choice to updating',async()=>{
 for(const action of [null,'rotate']) {
  const {interaction,replies,edits,defers}=mockInteraction(action);
  const calls: string[]=[];
  let expiryScheduled=false;
  await createInteractionHandler({
   access,
   service:{authorize:()=>true,get:async()=>{calls.push('read');return {id:'mac_01',password:'old123'};},rotate:async()=>{calls.push('rotate');return {id:'mac_01',password:'new456'};}},
   schedule:(_callback,delay)=>{assert.equal(delay,60000);expiryScheduled=true;},
  })(interaction);
  assert.deepEqual(calls,[action===null?'read':'rotate']);
  assert.deepEqual(defers,[{flags:64}]);
  assert.equal(replies.length,0);
  assert.match(edits[0]?.content ?? '',action===null?/old123/:/new456/);
  assert.deepEqual(edits[0]?.allowedMentions,{parse:[]});
  assert.equal(expiryScheduled,true);
 }
});

test('Discord refuses unknown actions before deferring or touching the backend',async()=>{
 for(const action of ['read','delete','secret-password','']) {
  const {interaction,replies,edits,defers}=mockInteraction(action);
  await createInteractionHandler({access,service:{authorize:()=>true,get:()=>assert.fail('backend touched'),rotate:()=>assert.fail('backend touched')}})(interaction);
  assert.equal(defers.length,0);
  assert.equal(edits.length,0);
  assert.deepEqual(replies,[{content:'処理に失敗しました。時間をおいて再試行してください。',flags:64,allowedMentions:{parse:[]}}]);
 }
});

test('both Discord actions deny unauthorized users and sanitize backend errors',async()=>{
 for(const action of [null,'rotate']) {
  const denied=mockInteraction(action);
  await createInteractionHandler({access,service:{authorize:()=>false,get:()=>assert.fail('backend touched'),rotate:()=>assert.fail('backend touched')}})(denied.interaction);
  assert.equal(denied.defers.length,0);
  assert.equal(denied.replies[0]?.content,'この操作は許可されていません。');
  const failed=mockInteraction(action);
  await createInteractionHandler({access,service:{authorize:()=>true,get:async()=>{throw Error('secret-password');},rotate:async()=>{throw Error('secret-password');}}})(failed.interaction);
  assert.deepEqual(failed.edits,[{content:'処理に失敗しました。時間をおいて再試行してください。',allowedMentions:{parse:[]}}]);
 }
});

test('reading neither consumes rotation cooldown nor waits for it',async()=>{
 let reads=0;let rotations=0;
 const credentials={id:'mac_01',password:'abc123'};
 const service=createCredentialService({...options,cooldownMs:60000,adapter:{readCredentials:async()=>{reads++;return credentials;},rotateCredentials:async()=>{rotations++;return credentials;}}});
 await service.get(identity);
 await service.get(identity);
 await service.rotate(identity);
 await service.get(identity);
 await service.get(identity);
 await assert.rejects(service.rotate(identity),{code:'COOLDOWN'});
 assert.equal(reads,4);assert.equal(rotations,1);
});

test('read and rotate share a lock regardless of which operation starts first',async()=>{
 for(const first of ['get','rotate'] as const) {
  let complete: ((value: Credentials)=>void) | undefined;
  const pending=new Promise<Credentials>(resolve=>{complete=resolve;});
  const service=createCredentialService({...options,adapter:{readCredentials:()=>pending,rotateCredentials:()=>pending}});
  const operation=service[first](identity);
  await assert.rejects(service.get(identity),{code:'BUSY'});
  await assert.rejects(service.rotate(identity),{code:'BUSY'});
  assert.ok(complete);complete({id:'mac_01',password:'abc123'});
  await operation;
  await service.get(identity);
  await service.rotate(identity);
 }
});

test('failed reads release the lock and do not consume rotation cooldown',async()=>{
 const service=createCredentialService({...options,cooldownMs:60000,adapter:{
  readCredentials:async()=>{throw Error('secret-password');},
  rotateCredentials:async()=>({id:'mac_01',password:'abc123'}),
 }});
 await assert.rejects(service.get(identity),error=>error instanceof CredentialError && error.code==='BACKEND_FAILED' && !String(error.stack).includes('secret-password') && error.cause===undefined);
 await service.rotate(identity);
 await assert.rejects(service.get(identity),{code:'BACKEND_FAILED'});
 await assert.rejects(service.rotate(identity),{code:'COOLDOWN'});
});
test('service rejects malformed boundary configuration', () => {
 for (const patch of [{access:{}}, {access:{authorize:42}}, {adapter:{rotateCredentials:42}}]) {
  assert.throws(() => createCredentialService({...options,adapter:{async readCredentials(){return {id:'1',password:'abc123'};},async rotateCredentials(){return {id:'1',password:'abc123'};}},...patch}), {message:'Invalid credential service configuration.'});
 }
});
test('malformed identity values are denied with a safe authorization error', async () => {
 const service=createCredentialService({...options,adapter:{async readCredentials(){return {id:'1',password:'abc123'};},async rotateCredentials(){return {id:'1',password:'abc123'};}}});
 for (const who of [null,undefined,{}, {userId:42,guildId:identity.guildId}]) {
  assert.equal(service.authorize(who),false);
  await assert.rejects(service.rotate(who),{code:'FORBIDDEN'});
  await assert.rejects(service.get(who),{code:'FORBIDDEN'});
 }
});
test('denies wrong user, guild and DM before touching adapter', async () => {
 let calls=0; const service=createCredentialService({...options,adapter:{async readCredentials(){calls++;},async rotateCredentials(){calls++;}}});
 for(const who of [{...identity,userId:'other'},{...identity,guildId:'other'},{...identity,userId:'444444444444444444'},{...identity,guildId:'444444444444444444'},{...identity,guildId:null}]) {
  assert.equal(service.authorize(who),false);
  await assert.rejects(service.rotate(who),{code:'FORBIDDEN'});
  await assert.rejects(service.get(who),{code:'FORBIDDEN'});
 }
 assert.equal(calls,0);
});
test('global lock rejects concurrent authorized users and releases after success',async()=>{
 const pendingRotation: {finish: ((value: Credentials) => void) | undefined}={finish:undefined}; const adapter={async readCredentials(){return {id:'1',password:'abc123'};},rotateCredentials:()=>new Promise<Credentials>(r=>{pendingRotation.finish=r;})};
 const service=createCredentialService({...options,allowedUserIds:[identity.userId,'333333333333333333'],adapter});
 const pending=service.rotate(identity);
 await assert.rejects(service.rotate({...identity,userId:'333333333333333333'}),{code:'BUSY'});
 assert.ok(pendingRotation.finish); pendingRotation.finish({id:'123456789',password:'abc123'}); assert.deepEqual(await pending,{id:'123456789',password:'abc123'});
 const next=service.rotate(identity); await new Promise<void>(resolve=>setImmediate(resolve)); assert.ok(pendingRotation.finish); pendingRotation.finish({id:'123456789',password:'xyz456'}); await next;
});
test('global cooldown prevents successive rotations',async()=>{
 let calls=0; const service=createCredentialService({...options,cooldownMs:60000,adapter:{async readCredentials(){return {id:'1',password:'abc123'};},async rotateCredentials(){calls++;return {id:'1',password:'abc123'};}}});
 await service.rotate(identity); await assert.rejects(service.rotate(identity),{code:'COOLDOWN'}); assert.equal(calls,1);
});
test('adapter failure releases lock and never exposes error or cause',async()=>{
 let calls=0; const secret='secret-password'; const service=createCredentialService({...options,adapter:{async readCredentials(){return {id:'1',password:'abc123'};},async rotateCredentials(){if(calls++===0) throw Error(secret);return {id:'1',password:'abc123'};}}});
 await assert.rejects(service.rotate(identity),error=>error instanceof CredentialError && error.code==='BACKEND_FAILED'&&!String(error.stack).includes(secret)&&error.cause===undefined);
 assert.equal((await service.rotate(identity)).password,'abc123');
});
test('Discord denial occurs before defer and backend call',async()=>{
 const events: InteractionReplyOptions[]=[]; const handler=createInteractionHandler({access,service:{authorize:()=>false,get:()=>assert.fail('backend touched'),rotate:()=>assert.fail('backend touched')}});
 await handler({isChatInputCommand:()=>true,commandName:'rustdesk',options:{getString:()=>null,getUser:()=>assert.fail('unexpected getUser')},user:{id:'bad'},guildId:identity.guildId,reply:async p=>events.push(p),deferReply:()=>assert.fail('deferred'),editReply:()=>assert.fail('edited'),deleteReply:()=>assert.fail('deleted')});
 assert.equal(events[0]?.flags,64); assert.deepEqual(events[0]?.allowedMentions,{parse:[]});
});
test('Discord uses ephemeral defer, safe errors, and best effort expiry',async()=>{
 const events: InteractionEditReplyOptions[]=[]; const defers: InteractionDeferReplyOptions[]=[]; let deleted=false;
 let expire: (() => Promise<void>) | undefined;
 const interaction: CommandInteraction={isChatInputCommand:()=>true,commandName:'rustdesk',options:{getString:()=>null,getUser:()=>assert.fail('unexpected getUser')},user:{id:identity.userId},guildId:identity.guildId,reply:()=>assert.fail('unexpected reply'),deferReply:async p=>defers.push(p),editReply:async p=>events.push(p),deleteReply:async()=>{deleted=true;throw Error('sensitive');}};
 await createInteractionHandler({access,service:{authorize:()=>true,get:async()=>({id:'123',password:'abc123'}),rotate:()=>assert.fail('unexpected rotate')},schedule:(fn,ms)=>{assert.equal(ms,60000);expire=fn;}})(interaction);
 assert.equal(defers[0]?.flags,64); assert.match(events[0]?.content ?? '',/abc123/); assert.deepEqual(events[0]?.allowedMentions,{parse:[]}); assert.ok(expire); await expire(); assert.equal(deleted,true);
 events.length=0;
 await createInteractionHandler({access,service:{authorize:()=>true,get:async()=>{throw Error('secret-password');},rotate:()=>assert.fail('unexpected rotate')}})(interaction);
 assert.ok(!JSON.stringify(events).includes('secret-password'));
});

test('invalid credential payloads are sanitized before Discord can receive them',async()=>{
 for(const credentials of [null,{id:'123',password:'secret\n@everyone'},{id:'123\nmalicious',password:'abc123'},{id:'123',password:123}]){
  const service=createCredentialService({...options,adapter:{async readCredentials(){return credentials;},async rotateCredentials(){return credentials;}}});
  await assert.rejects(service.rotate(identity),{code:'BACKEND_FAILED'});
  await assert.rejects(service.get(identity),{code:'BACKEND_FAILED'});
 }
});
test('failed attempts also apply the global cooldown',async()=>{
 let calls=0;
 const service=createCredentialService({...options,cooldownMs:60000,adapter:{async readCredentials(){return {id:'1',password:'abc123'};},async rotateCredentials(){calls++;throw Error('secret');}}});
 await assert.rejects(service.rotate(identity),{code:'BACKEND_FAILED'});
 await assert.rejects(service.rotate(identity),{code:'COOLDOWN'});
 assert.equal(calls,1);
});

test('accepts custom RustDesk IDs and enforces adapter credential bounds', async () => {
 for (const id of ['my-mac_01', 'x'.repeat(64), '123456789']) {
  const service = createCredentialService({...options, adapter: {async readCredentials(){return {id, password:'abc123'};},async rotateCredentials() {return {id, password: 'abc123'};}}});
  assert.equal((await service.rotate(identity)).id, id);
  assert.equal((await service.get(identity)).id,id);
 }
 for (const credentials of [{id: 'x'.repeat(65), password: 'abc123'}, {id: 'my.mac', password: 'abc123'}, {id: 'mac', password: 'short'}, {id: 'mac', password: 'x'.repeat(65)}]) {
  const service = createCredentialService({...options, adapter: {async readCredentials(){return credentials;},async rotateCredentials() {return credentials;}}});
  await assert.rejects(service.rotate(identity), {code: 'BACKEND_FAILED'});
  await assert.rejects(service.get(identity), {code: 'BACKEND_FAILED'});
 }
});
