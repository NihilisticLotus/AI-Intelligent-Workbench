import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PhotoAttachment } from './Attachments';

it('移动图片入口分别提供相册多选和相机输入', () => {
  const html = renderToStaticMarkup(createElement(PhotoAttachment, { add: () => {} }));
  const inputs = html.match(/<input [^>]+>/g) ?? [];
  expect(inputs).toHaveLength(2);
  expect(inputs[0]).toContain('accept="image/*"');
  expect(inputs[0]).toContain('multiple');
  expect(inputs[0]).not.toContain('capture=');
  expect(inputs[1]).toContain('capture="environment"');
  expect(html).toContain('aria-label="添加图片"');
  expect(html).toContain('aria-haspopup="menu"');
});
