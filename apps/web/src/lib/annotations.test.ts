import { describe, expect, it } from 'vitest';
import { ANNOTATION_TEXT_MAX, clipSelection, composeWithAnnotations } from './annotations';

describe('对话注释', () => {
  it('没有注释时消息原样发送', () => {
    expect(composeWithAnnotations('  你好  ', [])).toBe('你好');
  });

  it('注释附在消息后面：引用原文，有评论时带上评论', () => {
    const out = composeWithAnnotations('按这两处改', [
      { id: 'a', text: '第一行\n第二行', comment: '这里不对' },
      { id: 'b', text: '另一处', comment: '  ' },
    ]);
    expect(out).toContain('按这两处改\n\n---');
    expect(out).toContain('标注了 2 处内容');
    expect(out).toContain('1. 所选文本：\n> 第一行\n> 第二行\n\n   用户评论：这里不对');
    expect(out).toContain('2. 所选文本：\n> 另一处');
    expect(out).not.toContain('2. 所选文本：\n> 另一处\n\n   用户评论');
  });

  it('只有注释、没有输入文字也能发送', () => {
    const out = composeWithAnnotations('', [{ id: 'a', text: 'x', comment: '' }]);
    expect(out.startsWith('我在对话里标注了 1 处内容')).toBe(true);
  });

  it('过长的选中内容会截断', () => {
    expect(clipSelection('a'.repeat(ANNOTATION_TEXT_MAX + 10)).length).toBe(ANNOTATION_TEXT_MAX + 1);
  });
});

describe('恢复注释位置', () => {
  it('多处相同的原文取离原位置最近的一处', async () => {
    const { nearestIndex } = await import('./annotations');
    const all = 'abc 改这里 xyz 改这里 end';
    expect(nearestIndex(all, '改这里', 0)).toBe(4);
    expect(nearestIndex(all, '改这里', 12)).toBe(12);
    expect(nearestIndex(all, '没有', 0)).toBe(-1);
    expect(nearestIndex(all, '', 0)).toBe(-1);
  });
});
