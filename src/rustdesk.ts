import net from 'node:net';
import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { userInfo } from 'node:os';
import type { z } from 'zod';
import {
  adapterOptionsSchema, configResponseSchema, credentialsSchema,
  optionsResponseSchema, passwordSchema, rustDeskIdSchema,
} from './schemas.js';
import type { Credentials, CredentialOperation, IpcRequest } from './schemas.js';

const MAX_FRAME = 65536;
const failure = () => new Error('RustDesk IPC operation failed');

// RustDesk 1.5.0 internal IPC: serde tagged JSON carried by BytesCodec.
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_FRAME) throw failure();
  const size = body.length <= 63 ? 1 : body.length <= 16383 ? 2 : 3;
  const header = Buffer.alloc(size);
  header.writeUIntLE(body.length * 4 + size - 1, 0, size);
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  push(data: Uint8Array): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, data]);
    const messages: unknown[] = [];
    while (this.#buffer.length) {
      const first = this.#buffer[0];
      if (first === undefined) break;
      const size = (first & 3) + 1;
      if (this.#buffer.length < size) break;
      const length = Math.floor(this.#buffer.readUIntLE(0, size) / 4);
      if (length > MAX_FRAME) throw failure();
      if (this.#buffer.length < size + length) break;
      try {
        const message: unknown = JSON.parse(this.#buffer.subarray(size, size + length).toString('utf8'));
        messages.push(message);
      } catch { throw failure(); }
      this.#buffer = this.#buffer.subarray(size + length);
    }
    return messages;
  }
}

async function checkSocket(path: string): Promise<void> {
  const uid = userInfo().uid;
  const [directory, socket] = await Promise.all([lstat(dirname(path)), lstat(path)]);
  if (!directory.isDirectory() || !socket.isSocket() || directory.uid !== uid || socket.uid !== uid ||
      (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0) throw failure();
}

interface PendingQuery {
  receive(message: unknown): void;
  reject(error: Error): void;
}

// Exactly one outstanding query; writes and subsequent reads share the same stream.
class Connection {
  #socket: net.Socket;
  #decoder = new FrameDecoder();
  #pending: PendingQuery | undefined;
  #closed = false;

  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
    socket.on('data', (data: Buffer) => {
      try {
        for (const message of this.#decoder.push(data)) {
          if (!this.#pending) { this.close(); return; }
          const pending = this.#pending;
          this.#pending = undefined;
          pending.receive(message);
        }
      } catch { this.close(); }
    });
  }

  send(message: IpcRequest): void {
    if (this.#closed) throw failure();
    this.#socket.write(encodeFrame(message));
  }

  query<T>(message: IpcRequest, schema: z.ZodType<T>): Promise<T> {
    if (this.#closed || this.#pending) return Promise.reject(failure());
    return new Promise((resolve, reject) => {
      this.#pending = {
        reject,
        receive: value => {
          const result = schema.safeParse(value);
          if (result.success) resolve(result.data);
          else { reject(failure()); this.close(); }
        },
      };
      try { this.send(message); } catch { this.close(); }
    });
  }

  async config(key: string): Promise<string> {
    const responseSchema = configResponseSchema.refine(value => value.c[0] === key);
    const message = await this.query({ t: 'Config', c: [key, null] }, responseSchema);
    return message.c[1];
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending?.reject(failure());
    this.#pending = undefined;
    this.#socket.destroy();
  }
}

export interface RustDeskAdapter {
  readCredentials(): Promise<Credentials>;
  rotateCredentials(): Promise<Credentials>;
}

export function createRustDeskAdapter(options: unknown): RustDeskAdapter {
  const parsed = adapterOptionsSchema.safeParse(options);
  if (!parsed.success) throw failure();
  const { socketPath, timeoutMs } = parsed.data;
  let busy = false;
  async function execute(mode: CredentialOperation): Promise<Credentials> {
    if (busy) throw failure();
    busy = true;
    let connection: Connection | undefined;
    let socket: net.Socket | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      await checkSocket(socketPath);
      const operation = async (): Promise<Credentials> => {
        socket = net.createConnection(socketPath);
        const active = new Connection(socket);
        connection = active;
        await active.query({ t: 'Options', c: null }, optionsResponseSchema);
        const id = rustDeskIdSchema.parse(await active.config('id'));
        const previous = passwordSchema.parse(await active.config('temporary-password'));
        if (mode === 'read') return credentialsSchema.parse({ id, password: previous });
        active.send({ t: 'Config', c: ['temporary-password', ''] });
        // Reading on the same stream is the daemon-processing barrier for the write.
        const password = passwordSchema.refine(value => value !== previous)
          .parse(await active.config('temporary-password'));
        return credentialsSchema.parse({ id, password });
      };
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { connection?.close(); socket?.destroy(); reject(failure()); }, timeoutMs);
        }),
      ]);
    } catch { throw failure(); }
    finally { clearTimeout(timer); connection?.close(); socket?.destroy(); busy = false; }
  }
  return {
    readCredentials: () => execute('read'),
    rotateCredentials: () => execute('rotate'),
  };
}
