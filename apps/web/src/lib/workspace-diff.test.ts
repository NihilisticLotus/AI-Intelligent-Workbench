import { describe, expect, it } from 'vitest';
import { parseWorkspaceDiff, resolveChangeTarget } from './workspace-diff';

describe('工具记录定位实际改动', () => {
  const files = [{path:'a.txt'}, {path:'nested/a.txt'}, {path:'新名', oldPath:'旧名'}];
  it('同名文件按完整相对路径定位，重命名返回当前路径', () => {
    expect(resolveChangeTarget(files,'nested/a.txt','D:/work')).toBe('nested/a.txt');
    expect(resolveChangeTarget(files,'d:\\WORK\\nested\\a.txt','D:/work')).toBe('nested/a.txt');
    expect(resolveChangeTarget(files,'./旧名','/work')).toBe('新名');
  });
  it('目标缺失、副本之外、大小写有歧义时不选其他文件', () => {
    for(const target of ['missing/a.txt','D:/work-old/nested/a.txt','D:/else/a.txt'])
      expect(resolveChangeTarget(files,target,'D:/work')).toBeNull();
    expect(resolveChangeTarget([{path:'Ab'},{path:'aB'}],'AB','C:/work')).toBeNull();
    expect(resolveChangeTarget(files,'/WORK/a.txt','/work')).toBeNull();
  });
});

describe('实际改动补丁解析', () => {
  it('替换、上下文与多段补丁独立计旧新行号', () => {
    const rows = parseWorkspaceDiff('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -3,2 +3,3 @@\n 保留\n-原行\n+新行\n+新增\n@@ -20 +21 @@\n-旧\n+新\n');
    expect(rows.map(r => [r.kind, r.oldLine, r.newLine])).toEqual([['header',null,null],['context',3,3],['remove',4,null],['add',null,4],['add',null,5],['header',null,null],['remove',20,null],['add',null,21]]);
  });
  it('空文件新增、删除与无末尾换行不会错加行号', () => {
    expect(parseWorkspaceDiff('@@ -0,0 +1 @@\n+新文件\n\\ No newline at end of file\n')).toEqual([
      {kind:'header',text:'@@ -0,0 +1 @@',oldLine:null,newLine:null}, {kind:'add',text:'新文件',oldLine:null,newLine:1}, {kind:'note',text:'文件末尾没有换行',oldLine:null,newLine:null},
    ]);
    expect(parseWorkspaceDiff('@@ -1 +0,0 @@\n-删除\n')[1]).toMatchObject({kind:'remove',oldLine:1,newLine:null});
  });
  it('文件内容以加减和 HTML 开头仍作为正文', () => {
    const rows = parseWorkspaceDiff('--- a/危险\n+++ b/危险\n@@ -1 +1 @@\n---原文\n+++<script>正文</script>\n');
    expect(rows[1]?.text).toBe('--原文'); expect(rows[2]?.text).toBe('++<script>正文</script>');
  });
  it('纯重命名保留说明，不生成假的行号', () => {
    const rows = parseWorkspaceDiff('diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n');
    expect(rows.map(r => r.text)).toEqual(['rename from a','rename to b']); expect(rows.every(r => r.oldLine === null && r.newLine === null)).toBe(true);
  });
});
