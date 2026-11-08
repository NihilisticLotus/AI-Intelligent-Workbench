import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { IndependentCommandExecutor } from '../src/independent/commands';

const fixtures: { directory:string; executor:IndependentCommandExecutor }[] = [];
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function setup(mode: string) {
  const directory=mkdtempSync(path.join(tmpdir(),'aic-file-race-')),base=realpathSync.native(directory),root=path.join(base,'project'),data=path.join(base,'private');
  mkdirSync(root); mkdirSync(data); const executor=new IndependentCommandExecutor(data); fixtures.push({directory,executor});
  const target=path.join(root,'file.txt'),outside=path.join(base,'outside.txt'),ready=path.join(base,'ready'),resume=path.join(base,'resume'); writeFileSync(target,'原始内容');
  let source=readFileSync(fileURLToPath(new URL('../src/independent/file-guard.cs',import.meta.url)),'utf8');
  const inject=(needle:string,extra:string) => { expect(source.split(needle)).toHaveLength(2); source=source.replace(needle,needle+extra); };
  inject('stage = CreateStage(staging, security, attributes);',' AicFileRace.Before(stage, staging);');
  inject('ProtectStage(stage);',' AicFileRace.Protected(stage, staging);');
  inject('newStream = new FileStream(stage, FileAccess.ReadWrite);', ' if (AicFileRace.Mode == "kill") { newStream.Write(bytes, 0, 1); newStream.Flush(true); AicFileRace.Pause("partial", staging); }');
  inject('movedOriginal = true;', ' AicFileRace.Pause("moved", staging);');
  inject('Disposition(stage, false);', ' AicFileRace.Pause("cleared", staging);');
  inject('if (Hash(Content(oldStream, Limit)) != expectedHash) throw Error("conflict");',' AicFileRace.Pause("old", target);');
  source+='\n'+readFileSync(fileURLToPath(new URL('./fixtures/independent-file-race.cs',import.meta.url)),'utf8').replace(/^using .+;\r?\n/gm,'');
  const sourceFile=path.join(data,'fixture.cs'); writeFileSync(sourceFile,source);
  const configure=mode.startsWith('acl')?`function SnapshotAcl { $r=New-Object Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath ${quote(target)}).Sddl);$b=New-Object byte[] $r.DiscretionaryAcl.BinaryLength;$r.DiscretionaryAcl.GetBinaryForm($b,0);return @($r.Owner.Value,$r.Group.Value,[Convert]::ToBase64String($b),[int]($r.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)) -join '|'; };$acl=Get-Acl -LiteralPath ${quote(target)};$acl.SetAccessRuleProtection(${mode==='acl-protected'?'$true':'$false'},$true);Set-Acl -LiteralPath ${quote(target)} -AclObject $acl;$beforeAcl=SnapshotAcl;`:mode==='readonly'?`[IO.File]::SetAttributes(${quote(target)},[IO.FileAttributes]::ReadOnly);`:mode==='stream'?`Set-Content -LiteralPath ${quote(target)} -Stream meta -Value 'metadata' -Encoding Ascii -NoNewline;`:'';
  const after=mode.startsWith('acl')?`[Console]::WriteLine('acl='+((SnapshotAcl) -eq $beforeAcl));`:'';
  const script=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);Add-Type -TypeDefinition ([IO.File]::ReadAllText(${quote(sourceFile)},[Text.Encoding]::UTF8));[AicFileRace]::Mode=${quote(mode)};[AicFileRace]::Ready=${quote(ready)};[AicFileRace]::Resume=${quote(resume)};[AicFileRace]::Outside=${quote(outside)};${configure}$g=New-Object AicFileGuard(${quote(root)},${quote(data)});try{$null=$g.WriteFile('file.txt',${quote(hash('原始内容'))},[Text.Encoding]::UTF8.GetBytes('修改后的内容'),$false,$false);[Console]::WriteLine('written');${after}}catch{[Console]::WriteLine($_.Exception.GetBaseException().Message)}finally{[AicFileRace]::Close();$g.Dispose();[Console]::WriteLine(([AicFileRace]::Results-join ','))}`;
  const controller=new AbortController();
  let completed:string|null=null;
  const run=async()=>{const result=await executor.run({program:path.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),args:['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],timeoutMs:60_000,maxOutputBytes:8192},{cwd:root,signal:controller.signal});completed=result.stdout+'\n'+result.stderr;return result;};
  const pause=async(phase:string)=>{await vi.waitFor(()=>{if(completed!==null)throw Error('夹具提前结束：'+completed);expect(existsSync(ready)&&readFileSync(ready,'utf8').startsWith(phase+'\n')).toBe(true);},{timeout:15_000});return readFileSync(ready,'utf8').split('\n')[1]!;};
  return {root,target,outside,ready,resume,controller,run,pause,release:()=>writeFileSync(resume,'继续')};
}
afterEach(async()=>{for(const f of fixtures.splice(0)){await f.executor.close();const absolute=path.resolve(f.directory);if(path.dirname(absolute)!==path.resolve(tmpdir())||!path.basename(absolute).startsWith('aic-file-race-'))throw Error('拒绝范围外清理');rmSync(absolute,{recursive:true,force:true,maxRetries:5,retryDelay:100});}});

describe('文件发布的实际并发夹具',()=>{
  it('旧目标校验后新增外部硬链接，发布只改变项目路径，外部别名保留原文',async()=>{
    const f=setup('old');const pending=f.run();await f.pause('old');linkSync(f.target,f.outside);f.release();const result=await pending;
    expect(result.stdout).toContain('written');expect(readFileSync(f.target,'utf8')).toBe('修改后的内容');expect(readFileSync(f.outside,'utf8')).toBe('原始内容');expect(readdirSync(f.root)).toEqual(['file.txt']);
  },30_000);
  it('暂存屏障前已有别名时拒绝写正文，原项目文件与外部空别名均不变',async()=>{
    const f=setup('prealias');const result=await f.run();expect(result.stdout).toContain('aic_forbidden');expect(readFileSync(f.target,'utf8')).toBe('原始内容');expect(readFileSync(f.outside)).toHaveLength(0);expect(readdirSync(f.root)).toEqual(['file.txt']);
  },30_000);
  it('阳性对照有效，pending 阻断预开属性和零访问句柄、扩展链接与文件 ID 旁路',async()=>{
    const f=setup('handles');const pending=f.run();const staging=await f.pause('protected');expect(()=>linkSync(staging,f.outside)).toThrow();f.release();const result=await pending;
    for(const name of ['control','controlEx','controlId'])expect(result.stdout).toContain(name+'=00000000');expect(result.stdout).toContain('preid=opened');const count=4;expect(result.stdout.match(/preopened=c0000022/g)).toHaveLength(count);expect(result.stdout.match(/extended=c0000022/g)).toHaveLength(count);expect(result.stdout).toContain('byid=denied:5');expect(result.stdout).toContain('written');expect(existsSync(f.outside)).toBe(false);expect(readFileSync(f.target,'utf8')).toBe('修改后的内容');
    for(let i=1;i<=count;i++)expect(readFileSync(f.outside+'.ex'+i,'utf8')).toBe('外部原文');
  },30_000);
  it('新文件全部写完清除屏障后出现别名，发布之后不会再改其字节',async()=>{
    const f=setup('cleared');const pending=f.run();const staging=await f.pause('cleared');linkSync(staging,f.outside);f.release();const result=await pending;
    expect(result.stdout).toContain('written');expect(readFileSync(f.outside,'utf8')).toBe('修改后的内容');expect(readFileSync(f.target)).toEqual(readFileSync(f.outside));
  },30_000);
  it('旧目标移走后竞争者占名，结果未定且保留旧旁路文件，不覆盖或自动回滚',async()=>{
    const f=setup('moved');const pending=f.run();await f.pause('moved');expect(existsSync(f.target)).toBe(false);writeFileSync(f.target,'用户占名');f.release();const result=await pending;
    expect(result.stdout).toContain('aic_interrupted');expect(readFileSync(f.target,'utf8')).toBe('用户占名');const old=readdirSync(f.root).filter(n=>n.startsWith('.aic-old-'));expect(old).toHaveLength(1);expect(readFileSync(path.join(f.root,old[0]!),'utf8')).toBe('原始内容');expect(readdirSync(f.root).some(n=>n.startsWith('.aic-stage-'))).toBe(false);
  },30_000);
  it('实际暂存写入中取消宿主，pending 临时文件消失，旧项目原文保持完整',async()=>{
    const f=setup('kill');const pending=f.run();const staging=await f.pause('partial');f.controller.abort();expect((await pending).reason).toBe('cancelled');expect(existsSync(staging)).toBe(false);expect(readFileSync(f.target,'utf8')).toBe('原始内容');expect(readdirSync(f.root)).toEqual(['file.txt']);
  },30_000);
  it.each(['acl-protected','acl-inherited'])('发布保留既有 ACL 的所有者、组、DACL 字节及保护位（%s）',async(mode)=>{
    const f=setup(mode);const result=await f.run();expect(result.stdout).toContain('written');expect(result.stdout).toContain('acl=True');expect(readFileSync(f.target,'utf8')).toBe('修改后的内容');
  },30_000);
  it('只读目标明确拒绝，不通过新建文件绕过原保护',async()=>{
    const f=setup('readonly');try{const result=await f.run();expect(result.stdout).toContain('aic_forbidden');expect(readFileSync(f.target,'utf8')).toBe('原始内容');expect(readdirSync(f.root)).toEqual(['file.txt']);}finally{chmodSync(f.target,0o666);}
  },30_000);
  it('具有额外数据流的文件拒绝替换，正文与流均保留',async()=>{
    const f=setup('stream');const result=await f.run();expect(result.stdout).toContain('aic_forbidden');expect(readFileSync(f.target,'utf8')).toBe('原始内容');expect(readFileSync(f.target+':meta','utf8')).toBe('metadata');
  },30_000);
});
