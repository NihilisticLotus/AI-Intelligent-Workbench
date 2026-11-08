// 跨进程持久预算夹具，只使用指定临时目录和虚构绑定，无网络与真实凭据。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDb } from '../../src/db';
import { IndependentRequestLedger } from '../../src/independent/request-ledger';
import { binding } from './independent-conversation';
import { seed } from './independent-journal';

const [directory] = process.argv.slice(2);
if (!directory) throw new Error('缺少临时目录');
const db = openDb(path.join(directory, 'requests.db')); seed(db);
const ledger = new IndependentRequestLedger(db);
ledger.create(binding, { maxRequests: 1, money: { currency: 'CNY', maxReservedMicros: 10, modelCeilingMicros: 10, counterCeilingMicros: null } });
const id = ledger.reserve(binding, { kind: 'model', requestHash: 'b'.repeat(64) });
writeFileSync(path.join(directory, 'ready'), JSON.stringify({ id, pid: process.pid }));
setInterval(() => {}, 1000);
