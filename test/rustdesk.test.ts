import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRustDeskAdapter, encodeFrame, FrameDecoder } from '../src/rustdesk.js';
import type { RustDeskAdapter } from '../src/rustdesk.js';
import { ipcRequestSchema } from '../src/schemas.js';
import type { IpcRequest } from '../src/schemas.js';

test('codec handles fragmented and combined frames, and bounds allocation', () => {
  const decoder = new FrameDecoder();
  const first = encodeFrame({t:'Config',c:['id','123456789']});
  const second = encodeFrame({t:'Config',c:['temporary-password','abc123']});
  assert.deepEqual(decoder.push(first.subarray(0,1)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(1),second])), [
    {t:'Config',c:['id','123456789']}, {t:'Config',c:['temporary-password','abc123']}
  ]);
  assert.throws(() => new FrameDecoder().push(Buffer.from([255,255,255,255])));
});

async function mockServer(handler: (message: IpcRequest, reply: (value: unknown) => void) => void, action: (adapter: RustDeskAdapter) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(),'rustdesk-bot-'));
  const path = join(dir,'ipc');
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close',()=>sockets.delete(socket));
    const decoder = new FrameDecoder();
    socket.on('data', (data: Buffer) => {
      for (const message of decoder.push(data)) handler(ipcRequestSchema.parse(message), value=>{socket.write(encodeFrame(value));});
    });
  });
  await new Promise<void>(resolve=>server.listen(path,resolve));
  await chmod(path, 0o600);
  try { await action(createRustDeskAdapter({socketPath:path,timeoutMs:100})); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve())); await rm(dir,{recursive:true,force:true}); }
}

test('read returns current credentials without any Config write', async () => {
  const requests: IpcRequest[]=[];
  await mockServer((message,reply)=>{
    requests.push(message);
    if(message.t==='Options') return reply({t:'Options',c:{}});
    reply({t:'Config',c:[message.c[0],message.c[0]==='id'?'mac_01':'old123']});
  },async adapter=>{
    assert.deepEqual(await adapter.readCredentials(),{id:'mac_01',password:'old123'});
    assert.deepEqual(requests,[{t:'Options',c:null},{t:'Config',c:['id',null]},{t:'Config',c:['temporary-password',null]}]);
  });
});

test('read fails safely on unsafe authentication or invalid credentials without writing',async()=>{
 for(const invalid of [
  {options:{'verification-method':'use-permanent-password'},id:'mac_01',password:'old123'},
  {options:{'approve-mode':'click'},id:'mac_01',password:'old123'},
  {options:null,id:'mac_01',password:'old123'},
  {options:{},id:'invalid.id',password:'old123'},
  {options:{},id:'mac_01',password:'secret\n@everyone'},
 ]) {
  let writes=0;
  await mockServer((message,reply)=>{
   if(message.t==='Options') return reply({t:'Options',c:invalid.options});
   if(message.c[1]!==null) writes++;
   reply({t:'Config',c:[message.c[0],message.c[0]==='id'?invalid.id:invalid.password]});
  },async adapter=>{
   await assert.rejects(adapter.readCredentials(),{message:'RustDesk IPC operation failed'});
   assert.equal(writes,0);
  });
 }
});

test('adapter shares the IPC lock across reads and rotations',async()=>{
 for(const method of ['readCredentials','rotateCredentials'] as const) {
  await mockServer(()=>{},async adapter=>{
   const active=adapter[method]();
   await assert.rejects(adapter.readCredentials(),{message:'RustDesk IPC operation failed'});
   await assert.rejects(adapter.rotateCredentials(),{message:'RustDesk IPC operation failed'});
   await assert.rejects(active,{message:'RustDesk IPC operation failed'});
  });
 }
});

test('rotation waits for new password and returns ID', async () => {
  let password='old123'; let writes=0;
  await mockServer((msg,reply)=>{
    if (msg.t === 'Options') return reply({t:'Options',c:{}});
    const [key,value]=msg.c;
    if(value!==null){ writes++; password='new456'; return; }
    reply({t:'Config',c:[key,key==='id'?'123456789':password]});
  },async adapter=>{ assert.deepEqual(await adapter.rotateCredentials(),{id:'123456789',password:'new456'}); assert.equal(writes,1); });
});

test('unchanged password fails closed without disclosing it', async () => {
  await mockServer((msg,reply)=>{
    if(msg.t==='Options') return reply({t:'Options',c:{}});
    const [key,value]=msg.c;
    if(value===null) reply({t:'Config',c:[key,key==='id'?'123456789':'old123']});
  }, async adapter=>{ await assert.rejects(adapter.rotateCredentials(),error=>!String(error).includes('old123')); });
});

test('permanent-only authentication refuses before rotating', async () => {
  let writes=0;
  await mockServer((msg,reply)=>{
    if(msg.t==='Options') reply({t:'Options',c:{'verification-method':'use-permanent-password'}});
    else if(msg.c[1]!==null) writes++;
  }, async adapter=>{ await assert.rejects(adapter.rotateCredentials()); assert.equal(writes,0); });
});

test('missing socket and invalid socket paths fail safely', async()=>{
  assert.throws(()=>createRustDeskAdapter({socketPath:'relative'}));
  await assert.rejects(createRustDeskAdapter({socketPath:'/nonexistent/rustdesk/ipc',timeoutMs:100}).rotateCredentials());
});


test('unresponsive and malformed IPC responses fail safely', async()=>{
  await mockServer(()=>{},async adapter=>{ await assert.rejects(adapter.rotateCredentials()); });
  await mockServer((msg,reply)=>reply({t:'unexpected'}),async adapter=>{ await assert.rejects(adapter.rotateCredentials()); });
});

test('adapter rejects NUL paths and invalid timeout values at construction', () => {
 for (const options of [{socketPath:'/tmp/ipc\0'}, {socketPath:'/tmp/ipc',timeoutMs:Infinity}, {socketPath:'/tmp/ipc',timeoutMs:0}, {socketPath:'/tmp/ipc',timeoutMs:2_147_483_648}]) {
  assert.throws(()=>createRustDeskAdapter(options),{message:'RustDesk IPC operation failed'});
 }
});

test('invalid Options payloads fail before any credential query or rotation', async () => {
 for (const payload of [null, [], {'verification-method':42}, {'approve-mode':'click'}, {'approve-mode':null}]) {
  let credentialRequests=0;
  await mockServer((message,reply)=>{
   if(message.t==='Options') reply({t:'Options',c:payload});
   else credentialRequests++;
  },async adapter=>{
   await assert.rejects(adapter.rotateCredentials(),{message:'RustDesk IPC operation failed'});
   assert.equal(credentialRequests,0);
  });
 }
});

test('invalid Config response keys, tuple lengths and value types fail before rotation', async () => {
 for (const payload of [['wrong-key','secret'], ['id'], ['id','secret','extra'], ['id',42], ['id',null]]) {
  let writes=0;
  await mockServer((message,reply)=>{
   if(message.t==='Options') return reply({t:'Options',c:{}});
   if(message.c[1]!==null) writes++;
   else reply({t:'Config',c:payload});
  },async adapter=>{
   await assert.rejects(adapter.rotateCredentials(),{message:'RustDesk IPC operation failed'});
   assert.equal(writes,0);
  });
 }
});

test('supported and empty authentication options allow temporary password rotation', async () => {
 for (const options of [
  {'verification-method':'','approve-mode':''},
  {'verification-method':'use-temporary-password','approve-mode':'password'},
  {'verification-method':'use-both-passwords','approve-mode':'password-click'},
 ]) {
  let password='old123';
  await mockServer((message,reply)=>{
   if(message.t==='Options') return reply({t:'Options',c:options});
   const [key,value]=message.c;
   if(value!==null) {password='new456';return;}
   reply({t:'Config',c:[key,key==='id'?'mac_01':password]});
  },async adapter=>{assert.deepEqual(await adapter.rotateCredentials(),{id:'mac_01',password:'new456'});});
 }
});
