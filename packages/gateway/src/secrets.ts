// 密钥存储（phase-1.md 6.4.3）：Windows DPAPI（经 PowerShell 调 ProtectedData，用户级）。
// - 明文和 entropy 通过 stdin 传入（base64），绝不放在命令行参数里（进程列表里谁都能看到命令行）。
// - entropy 是首次使用时生成的 32 字节随机数，存在 meta 表里：密文同时绑定 Windows 用户和这份数据目录。
// - 只在启动 Agent 进程、请求 /models、测试连接时解密；明文不缓存、不写日志。
// - 防不住：以同一 Windows 用户身份运行的恶意程序可以调用 DPAPI 解密（凭据管理器也一样）。
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Db } from './db';
import { Errors, newId, now } from './util';

export interface SecretStore {
  readonly scheme: string;
  readonly available: boolean;
  encrypt(plain: string): Promise<string>;
  decrypt(blob: string): Promise<string>;
}

const PS_EXE = 'powershell.exe';
/** 固定脚本：stdin 第 1 行 entropy、第 2 行数据（都是 base64），stdout 输出 base64 */
const psScript = (op: 'Protect' | 'Unprotect') => [
  'Add-Type -AssemblyName System.Security',
  '$lines = [Console]::In.ReadToEnd().Split([char]10)',
  '$e = [Convert]::FromBase64String($lines[0].Trim())',
  '$d = [Convert]::FromBase64String($lines[1].Trim())',
  `$r = [System.Security.Cryptography.ProtectedData]::${op}($d, $e, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
  '[Console]::Out.Write([Convert]::ToBase64String($r))',
].join('; ');

/** PowerShell 的命令行参数（导出给测试检查：里面不含明文） */
export const dpapiArgs = (op: 'Protect' | 'Unprotect') => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript(op)];

function runPs(op: 'Protect' | 'Unprotect', entropy: Buffer, data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(PS_EXE, dpapiArgs(op), { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      // 错误信息里不会有明文（明文只在 stdin 里），但也只给出简短原因
      if (err) return reject(new Error(`DPAPI ${op === 'Protect' ? '加密' : '解密'}失败`));
      const out = String(stdout).trim();
      if (!out) return reject(new Error('DPAPI 没有返回结果'));
      resolve(Buffer.from(out, 'base64'));
    });
    child.stdin?.end(`${entropy.toString('base64')}\n${data.toString('base64')}\n`);
  });
}

export class DpapiSecretStore implements SecretStore {
  readonly scheme = 'dpapi-user-v1';
  readonly available = process.platform === 'win32';
  constructor(private entropy: () => Buffer) {}
  async encrypt(plain: string) { return (await runPs('Protect', this.entropy(), Buffer.from(plain, 'utf8'))).toString('base64'); }
  async decrypt(blob: string) { return (await runPs('Unprotect', this.entropy(), Buffer.from(blob, 'base64'))).toString('utf8'); }
}

/** 只用于测试：密文是随机 id，明文留在内存里 */
export class MemorySecretStore implements SecretStore {
  readonly scheme = 'memory-test';
  readonly available = true;
  private map = new Map<string, string>();
  async encrypt(plain: string) { const id = randomBytes(12).toString('base64url'); this.map.set(id, plain); return id; }
  async decrypt(blob: string) { const v = this.map.get(blob); if (v === undefined) throw new Error('找不到密钥'); return v; }
}

/** 非 Windows：第一阶段不支持保存密钥 */
export class UnavailableSecretStore implements SecretStore {
  readonly scheme = 'none';
  readonly available = false;
  async encrypt(): Promise<string> { throw Errors.secretUnavailable('这台电脑上不能保存密钥', '第一阶段只支持在 Windows 上保存 API Key'); }
  async decrypt(): Promise<string> { throw Errors.secretUnavailable('这台电脑上不能读取密钥'); }
}

/** 数据目录专属的 entropy（首次使用时生成） */
export function entropyFrom(db: Db): () => Buffer {
  return () => {
    let v = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'secret_entropy'")?.value;
    if (!v) {
      v = randomBytes(32).toString('base64');
      db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('secret_entropy', ?)", v);
      v = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'secret_entropy'")!.value;
    }
    return Buffer.from(v, 'base64');
  };
}

export function defaultSecretStore(db: Db): SecretStore {
  return process.platform === 'win32' ? new DpapiSecretStore(entropyFrom(db)) : new UnavailableSecretStore();
}

/** 结尾 4 位（界面显示“结尾 …7Q2c”） */
export const secretHint = (plain: string) => (plain.length >= 8 ? plain.slice(-4) : '');

export class SecretService {
  constructor(private db: Db, readonly store: SecretStore) {}

  async save(plain: string): Promise<{ id: string; hint: string }> {
    if (!this.store.available) throw Errors.secretUnavailable('这台电脑上不能保存密钥', '第一阶段只支持在 Windows 上保存 API Key');
    const blob = await this.store.encrypt(plain);
    const id = newId('sec');
    const hint = secretHint(plain);
    this.db.run('INSERT INTO secrets (id, scheme, blob, hint, created_at) VALUES (?, ?, ?, ?, ?)', id, this.store.scheme, blob, hint, now());
    return { id, hint };
  }

  async read(id: string): Promise<string | null> {
    const r = this.db.get<{ blob: string; scheme: string }>('SELECT blob, scheme FROM secrets WHERE id = ?', id);
    if (!r) return null;
    if (r.scheme !== this.store.scheme) throw Errors.secretUnavailable('密钥是用别的方式保存的，读不出来', '请在账号里重新填写 API Key');
    try { return await this.store.decrypt(r.blob); } catch {
      throw Errors.secretUnavailable('密钥解不开', '数据可能是从别的电脑或别的 Windows 用户复制过来的，请重新填写 API Key');
    }
  }

  hint(id: string | null): string | null {
    if (!id) return null;
    return this.db.get<{ hint: string }>('SELECT hint FROM secrets WHERE id = ?', id)?.hint ?? null;
  }

  delete(id: string | null) { if (id) this.db.run('DELETE FROM secrets WHERE id = ?', id); }
}
