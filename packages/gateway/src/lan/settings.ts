import { networkInterfaces } from 'node:os';
import { PutLanBody, type LanInterface, type LanState } from '@aic/protocol';
import type { Db } from '../db';
import { Errors } from '../util';
import { firewallRuleName, LanFirewall, type FirewallTarget } from './firewall';
import { listPrivateInterfaces } from './interfaces';
import { networkProfiles } from './network-profile';
import { executeLanCommand, type LanExecutor } from './windows-executor';

const SETTINGS_KEY = 'lan_settings';

export interface LanDependencies {
  readInterfaces: typeof networkInterfaces;
  execute: LanExecutor;
  supported: boolean;
  program: string;
}

export class LanSettings {
  private readonly deps: LanDependencies;
  private readonly firewall: LanFirewall;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: Db, dataDir: string, private readonly port: () => number, deps?: Partial<LanDependencies>) {
    this.deps = { readInterfaces: networkInterfaces, execute: executeLanCommand, supported: process.platform === 'win32', program: process.execPath, ...deps };
    this.firewall = new LanFirewall(firewallRuleName(dataDir), this.deps.execute);
  }

  async state(): Promise<LanState> {
    const config = this.read();
    const interfaces = await this.interfaces();
    const selected = config.enabled
      ? interfaces.find((item) => item.name === config.name && item.address === config.address)
        ?? { name: config.name, address: config.address, category: 'unknown' as const }
      : null;
    const firewall = this.deps.supported ? await this.firewall.state(selected && this.target(selected)) : 'unknown';
    const unavailableReason = !this.deps.supported ? '局域网访问需要 Windows 防火墙' : selected
      ? this.selectionError(interfaces, selected)
      : interfaces.length ? null : '没有可用的私有 IPv4 网卡';
    return { enabled: false, requested: config.enabled, selected, interfaces, port: this.port(), firewall, unavailableReason };
  }

  put(body: PutLanBody): Promise<LanState> {
    return this.mutate(async () => {
      if (body.enabled) await this.requirePrivate(body);
      this.save(body);
      return this.state();
    });
  }

  updateFirewall(): Promise<LanState> {
    return this.mutate(async () => {
      const config = this.read();
      if (config.enabled) {
        await this.requirePrivate(config);
        const target = this.target(config);
        const status = await this.inspectFirewall(target);
        if (status !== 'matched') await this.firewall.change(status === 'missing' ? 'add' : 'set', target);
        if (await this.inspectFirewall(target) !== 'matched') throw Errors.conflict('Windows 防火墙规则与当前地址、程序或端口不匹配');
      } else if (await this.inspectFirewall(null) !== 'missing') {
        await this.firewall.change('delete');
        if (await this.inspectFirewall(null) !== 'missing') throw Errors.conflict('仍能查到 Windows 防火墙规则，请重新删除');
      }
      return this.state();
    });
  }

  private read(): PutLanBody {
    const row = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', SETTINGS_KEY);
    if (row) {
      try {
        const config = PutLanBody.safeParse(JSON.parse(row.value));
        if (config.success) return config.data;
      } catch { /* 不能识别的设置按关闭处理 */ }
    }
    return { enabled: false };
  }

  private save(config: PutLanBody) {
    this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      SETTINGS_KEY, JSON.stringify(config));
  }

  private async interfaces(): Promise<LanInterface[]> {
    if (!this.deps.supported) return [];
    const candidates = listPrivateInterfaces(this.deps.readInterfaces);
    if (!candidates.length) return [];
    const profiles = await networkProfiles(this.deps.execute);
    return candidates.map((item) => ({ ...item, category: profiles.get(item.name.toLowerCase()) ?? 'unknown' }));
  }

  private selectionError(interfaces: LanInterface[], selection: Pick<LanInterface, 'name' | 'address'>): string | null {
    const matching = interfaces.filter((item) => item.address === selection.address);
    const selected = matching.find((item) => item.name === selection.name);
    if (!selected) return '所选网卡或私有 IPv4 地址已不可用，请重新选择';
    if (matching.length !== 1) return '多张网卡正在使用相同地址，请选择其他地址';
    if (selected.category === 'public') return '所选网络是公用网络，请到 Windows 设置改为专用网络后再开启';
    if (selected.category === 'domain') return '所选网络是域网络，局域网访问只支持专用网络';
    if (selected.category !== 'private') return '无法确认所选网卡是专用网络，局域网访问保持关闭';
    return null;
  }

  private async requirePrivate(selection: Pick<LanInterface, 'name' | 'address'>) {
    if (!this.deps.supported) throw Errors.forbidden('局域网访问需要 Windows 防火墙');
    const reason = this.selectionError(await this.interfaces(), selection);
    if (reason) throw Errors.forbidden(reason);
  }

  private target({ address }: Pick<LanInterface, 'address'>): FirewallTarget {
    return { address, port: this.port(), program: this.deps.program };
  }

  private async inspectFirewall(target: FirewallTarget | null) {
    if (!this.deps.supported) throw Errors.forbidden('局域网访问需要 Windows 防火墙');
    const status = await this.firewall.state(target);
    if (status === 'unknown') throw Errors.conflict('无法查询 Windows 防火墙规则，请检查防火墙服务');
    return status;
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action, action);
    this.pending = next;
    return next;
  }
}
