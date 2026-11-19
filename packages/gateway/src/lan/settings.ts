import { PutLanBody, type LanInterface, type LanState } from '@aic/protocol';
import type { Db } from '../db';
import { AppError, Errors } from '../util';
import { firewallRuleName, LanFirewall, type FirewallTarget } from './firewall';
import { listPrivateInterfaces } from './interfaces';
import { networkProfiles } from './network-profile';
import { executeLanCommand, type LanExecutor } from './windows-executor';

const SETTINGS_KEY = 'lan_settings';

export interface LanDependencies {
  listInterfaces: () => Array<Omit<LanInterface, 'category'>>;
  execute: LanExecutor;
  supported: boolean;
  program: string;
}

type StopListener = () => Promise<void>;
type RuleAction = 'add' | 'set' | 'delete';
type RuleAudit = (action: RuleAction, result: 'ok' | 'failed') => void;

export class LanSettings {
  private readonly deps: LanDependencies;
  private readonly firewall: LanFirewall;
  private pending: Promise<unknown> = Promise.resolve();
  private active: { address: string; stop: StopListener } | null = null;
  private reason: string | null = null;
  private stopping = false;

  constructor(private readonly db: Db, dataDir: string, private readonly port: () => number,
    private readonly listen: (address: string) => Promise<StopListener>, private readonly log: (message: string) => void,
    deps?: Partial<LanDependencies>) {
    this.deps = { listInterfaces: listPrivateInterfaces, execute: executeLanCommand, supported: process.platform === 'win32', program: process.execPath, ...deps };
    this.firewall = new LanFirewall(firewallRuleName(dataDir), this.deps.execute);
  }

  activeAddress(): string | null { return this.active?.address ?? null; }

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
    return { enabled: this.active !== null, requested: config.enabled, selected, interfaces, port: this.port(), firewall,
      unavailableReason: unavailableReason ?? this.reason };
  }

  put(body: PutLanBody, audit?: RuleAudit): Promise<LanState> {
    return this.mutate(async () => {
      if (body.enabled) {
        await this.requirePrivate(body);
        const config = this.read();
        if (this.active?.address === body.address && config.enabled && config.name === body.name) return this.state();
      }
      this.reason = null;
      await this.deactivate();
      this.save({ enabled: false });
      try {
        if (body.enabled) {
          await this.ensureFirewall(this.target(body), true, audit);
          await this.requirePrivate(body);
          await this.activate(body.address);
          this.save(body);
        } else {
          await this.removeFirewall(audit);
        }
      } catch (error) {
        await this.deactivate();
        this.reason = error instanceof AppError ? error.message : '无法更改局域网设置';
        throw error;
      }
      return this.state();
    });
  }

  updateFirewall(audit?: RuleAudit): Promise<LanState> {
    return this.mutate(async () => {
      const config = this.read();
      try {
        if (config.enabled) {
          await this.requirePrivate(config);
          await this.ensureFirewall(this.target(config), false, audit);
          await this.requirePrivate(config);
          if (!this.active) await this.activate(config.address);
        } else {
          await this.removeFirewall(audit);
        }
      } catch (error) {
        await this.deactivate();
        this.reason = error instanceof AppError ? error.message : '无法更新 Windows 防火墙规则';
        throw error;
      }
      this.reason = null;
      return this.state();
    });
  }

  restore(): Promise<void> {
    return this.mutate(async () => {
      const config = this.read();
      if (!config.enabled) return;
      try {
        await this.requirePrivate(config);
        if (await this.inspectFirewall(this.target(config)) !== 'matched') {
          throw Errors.conflict('防火墙规则需要更新，请在设备与访问中检查');
        }
        await this.activate(config.address);
      } catch (error) {
        this.reason = error instanceof AppError ? error.message : '无法恢复上次的局域网设置';
        this.log(`局域网保持关闭：${this.reason}`);
      }
    });
  }

  stop(): Promise<void> {
    this.stopping = true;
    return this.deactivate();
  }

  private read(): PutLanBody {
    this.requireRunning();
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
    this.requireRunning();
    this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      SETTINGS_KEY, JSON.stringify(config));
  }

  private async interfaces(): Promise<LanInterface[]> {
    if (!this.deps.supported) return [];
    const candidates = this.deps.listInterfaces();
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

  private async ensureFirewall(target: FirewallTarget, interactive: boolean, audit?: RuleAudit) {
    const status = await this.inspectFirewall(target);
    if (!interactive && status === 'matched') return;
    await this.deactivate();
    this.requireRunning();
    await this.changeRule(status === 'missing' ? 'add' : 'set', target, audit);
    if (await this.inspectFirewall(target) !== 'matched') throw Errors.conflict('Windows 防火墙规则与当前地址、程序或端口不匹配');
  }

  private async removeFirewall(audit?: RuleAudit) {
    if (!this.deps.supported || await this.inspectFirewall(null) === 'missing') return;
    this.requireRunning();
    await this.changeRule('delete', null, audit);
    if (await this.inspectFirewall(null) !== 'missing') throw Errors.conflict('仍能查到 Windows 防火墙规则，请重新删除');
  }

  private async changeRule(action: RuleAction, target: FirewallTarget | null, audit?: RuleAudit) {
    try { await this.firewall.change(action, target); }
    catch (error) { audit?.(action, 'failed'); throw error; }
    audit?.(action, 'ok');
  }

  private async activate(address: string) {
    this.requireRunning();
    let stop: StopListener;
    try { stop = await this.listen(address); } catch {
      throw Errors.conflict('无法监听所选局域网地址，局域网访问保持关闭', '请检查网卡连接与端口占用');
    }
    if (this.stopping) {
      await stop();
      return;
    }
    this.active = { address, stop };
  }

  private deactivate(): Promise<void> {
    const active = this.active;
    this.active = null;
    return active?.stop() ?? Promise.resolve();
  }

  private requireRunning() {
    if (this.stopping) throw Errors.invalidState('工作台正在退出');
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action, action);
    this.pending = next;
    return next;
  }
}
