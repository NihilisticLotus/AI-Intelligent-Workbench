import type { GatewayOptions } from '../../src/server';
import { startGw } from '../helpers';

export const LAN_ALIAS = '127.0.0.2';
export const LAN_SELECTION = { enabled: true, name: '离线网卡', address: LAN_ALIAS } as const;

export async function startLanGateway(extra: GatewayOptions = {}, dataDir?: string) {
  let rule: object | null = null;
  return startGw({
    ...extra,
    lan: {
      supported: true,
      listInterfaces: () => [{ name: LAN_SELECTION.name, address: LAN_ALIAS }],
      async execute(cmd) {
        if (cmd.kind === 'network-profile') return { status: 'ok', stdout: JSON.stringify([{ name: LAN_SELECTION.name, category: 'Private' }]) };
        if (cmd.kind === 'firewall-query') return { status: 'ok', stdout: JSON.stringify(rule ? [rule] : []) };
        const args = cmd.env?.AIC_LAN_RULE_ARGS ?? '';
        rule = args.includes('"delete"') ? null : {
          address: LAN_ALIAS, remoteAddress: 'LocalSubnet', port: /"localport=(\d+)"/.exec(args)?.[1], program: process.execPath,
          profiles: 2, protocol: 6, direction: 1, action: 1, enabled: true, edge: false,
        };
        return { status: 'ok', stdout: '' };
      },
      ...extra.lan,
    },
  }, dataDir);
}
