import { describe, expect, it } from 'vitest';
import { diffFile } from '../src/acp/updates';
import { fakeAdapter, RecordingHost, scenario } from './helpers';
describe('工具 diff 结构化摘要',()=>{
  it('相同头尾不计入改动，空原文表示新建，缺正文不冒充零',()=>{
    expect(diffFile({path:'a',oldText:'head\nold\ntail',newText:'head\nnew\nsecond\ntail'})).toEqual({path:'a',added:2,removed:1,created:false});
    expect(diffFile({path:'a',oldText:null,newText:'one\ntwo'})).toEqual({path:'a',added:2,removed:0,created:true});
    expect(diffFile({path:'a',newText:'one'})).toEqual({path:'a',added:null,removed:null,created:false});
    expect(diffFile({oldText:'',newText:''})).toBeNull();
  });
  it('真实假 ACP 链路同时保留摘要文字与 files 事件',async()=>{
    const sc=scenario({turns:[{steps:[{update:{sessionUpdate:'tool_call',toolCallId:'edit',title:'编辑',kind:'edit',status:'completed',content:[{type:'diff',path:'a.ts',oldText:'a',newText:'b\nc'}]}}]}]});
    const host=new RecordingHost(), conn=await fakeAdapter(sc).spawn({cwd:sc.dir,model:null,effort:null,permission:'ask',host});
    conn.ready?.();
    try { await conn.prompt({text:'修改夹具'},new AbortController().signal); expect(host.updates).toContainEqual({kind:'tool_output',toolId:expect.any(String),text:'修改 a.ts（+2 −1）'}); expect(host.updates).toContainEqual({kind:'tool_update',toolId:expect.any(String),files:[{path:'a.ts',added:2,removed:1,created:false}]}); }
    finally {await conn.close();sc.cleanup();}
  });
});
