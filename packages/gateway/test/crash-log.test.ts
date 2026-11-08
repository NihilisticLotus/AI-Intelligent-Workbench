import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GATEWAY_LOG, gatewayLog, installCrashHandlers, lifecycle, readLastExit } from '../src/crash-log';

describe('兜底错误处理（ISSUE-0015）', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  const setup = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aic-crash-'));
    const printed: string[] = [];
    const fatals: unknown[] = [];
    const off = installCrashHandlers({ dataDir: dir, print: (m) => printed.push(m), onFatal: (e) => fatals.push(e) });
    cleanups.push(off, () => rmSync(dir, { recursive: true, force: true }));
    const log = () => readFileSync(path.join(dir, 'logs', GATEWAY_LOG), 'utf8');
    return { dir, printed, fatals, log };
  };

  it('未处理的 Promise 拒绝：写日志、提示、不退出', () => {
    const { printed, fatals, log } = setup();
    process.emit('unhandledRejection', new Error('后台写入失败'), Promise.resolve());
    expect(fatals).toHaveLength(0);
    expect(log()).toContain('后台写入失败');
    expect(log()).toContain('ERROR');
    expect(printed.join('\n')).toContain('服务继续运行');
  });

  it('未捕获的异常：写完整堆栈，调用 onFatal 一次，终端给出日志位置', () => {
    const { printed, fatals, log } = setup();
    const err = new TypeError('读取不到属性');
    process.emit('uncaughtException', err, 'uncaughtException');
    process.emit('uncaughtException', new Error('第二次'), 'uncaughtException');
    expect(fatals).toEqual([err]);
    expect(log()).toContain('FATAL');
    expect(log()).toContain('TypeError: 读取不到属性');
    expect(log()).toMatch(/at .+crash-log\.test/);
    expect(printed.join('\n')).toContain(GATEWAY_LOG);
  });

  it('日志里的密钥会被脱敏', () => {
    const { dir, log } = setup();
    gatewayLog(dir, 'ERROR', '请求失败 Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    expect(log()).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
  });
  it.each([true, false])('致命异常的文件和终端都脱敏，保留原始收尾参数（Error=%s）', (asError) => {
    const { printed, fatals, log } = setup();
    const synthetic = 'only-a-synthetic-bearer-value';
    const raw = `合成故障 Authorization: Bearer ${synthetic}`;
    const reason = asError ? new Error(raw) : raw;
    process.emit('uncaughtException', reason, 'uncaughtException');
    expect(log()).not.toContain(synthetic);
    expect(printed.join('\n')).not.toContain(synthetic);
    expect(printed.join('\n')).toContain('合成故障');
    expect(fatals).toEqual([reason]);
  });
  it('致命错误即使完成收尾也不算正常退出', () => {
    const {dir}=setup();lifecycle(dir,'start',Date.now(),'启动');lifecycle(dir,'exit',Date.now(),'未捕获异常',1);
    expect(readLastExit(dir)).toMatchObject({clean:false,reason:'未捕获异常'});
  });
});
