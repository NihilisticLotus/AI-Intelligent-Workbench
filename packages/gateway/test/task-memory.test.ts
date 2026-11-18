import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db';
import { TaskMemory, outputExcerpt } from '../src/task-memory';
import { taskSummaryBody, limitTaskSummary, TASK_FILE_BYTES } from '../src/task-summary';
import { MemorySecretStore, SecretService } from '../src/secrets';
import { EventStore, EventBus } from '../src/events';

let db: Db;
function setup() {
  db = openDb(':memory:');
  db.run("INSERT INTO tasks(id,project_id,title,prompt,status,permission_level,agent,last_activity_at,created_at,updated_at) VALUES('t','p','旧任务','保留目标','draft','ask','fake',1,1,1)");
  return {mem:new TaskMemory(db,()=>['synthetic-session-key']),events:new EventStore(db,new EventBus()),base:{taskId:'t',sessionId:'s'}};
}
afterEach(()=>db?.close());
describe('任务账本与说明',()=>{
  it('从旧记录重建，忽略回放、拒绝的编辑，保留审批理由及脱敏命令输出',()=>{
    const {mem,events,base}=setup();
    events.append({...base,type:'tool.start',data:{toolId:'a',kind:'edit',title:'编辑',target:'wrong.txt'}});
    events.append({...base,type:'tool.end',data:{toolId:'a',ok:false,rejected:true,summary:'未执行'}});
    events.append({...base,type:'tool.start',data:{toolId:'b',kind:'execute',title:'执行',target:'test synthetic-session-key'}});
    for (const text of ['错误 synthetic-','session-key']) events.append({...base,type:'tool.output',data:{toolId:'b',text}});
    events.append({...base,type:'tool.end',data:{toolId:'b',ok:false,summary:null}});
    const replay=events.append({...base,type:'plan.update',data:{items:[{text:'回放的计划',status:'pending'}]}});
    db.run('UPDATE events SET replay=1 WHERE seq=?',replay.seq);
    db.run("INSERT INTO approvals(id,task_id,session_id,request_json,status,created_at) VALUES('a','t','s',?,'rejected',2)",JSON.stringify({title:'编辑',detail:'wrong.txt',note:'保留项目规则'}));
    events.append({...base,type:'approval.resolved',data:{approvalId:'a',status:'rejected',decidedBy:null,optionId:'reject'}});
    const first=mem.list('t');
    expect(first.map(i=>i.kind)).toEqual(['goal','command','constraint']);
    expect(first[1]?.content).toEqual({command:'test ***',ok:false,output:'错误 ***'});
    expect(first[2]?.content).toContain('保留项目规则');
    expect(new TaskMemory(db).list('t')).toEqual(first);
  });
  it('截取工具输出首尾各 20 行，中文说明按 UTF-8 字节限制且保留完整账本',()=>{
    const {mem}=setup();
    const lines=Array.from({length:41},(_,i)=>'第'+(i+1)+'行').join('\n');
    expect(outputExcerpt(lines)).toContain('第20行\n…（中间输出已省略）\n第22行');
    mem.constrain('t',{kind:'constraint',content:'文本😀'.repeat(8000)});
    const items=mem.list('t'), text=limitTaskSummary(taskSummaryBody(items));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TASK_FILE_BYTES);
    expect(text).toContain('完整记录见工作台任务账本');
    expect(text).not.toContain('\ufffd');
    expect(items.at(-1)?.content).toBe('文本😀'.repeat(8000));
  });
  it('发布前只解密可能命中的工作台密文，并完整替换短 Key',async()=>{
    setup();
    const secrets=new SecretService(db,new MemorySecretStore());
    await secrets.save('synthetic-local-abcdefgh');
    await secrets.save('Q12');
    expect(await secrets.forRedaction('原始任务说明')).toEqual(['Q12']);
    const body='保留关卡 Q12 synthetic-local-abcdefgh。';
    expect(limitTaskSummary(body,await secrets.forRedaction(body))).toBe('保留关卡 *** ***。');
  });
});
