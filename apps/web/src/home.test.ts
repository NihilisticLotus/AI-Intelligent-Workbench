import { afterEach, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { Task } from '@aic/protocol';
import { Home } from './App';
import { appStore } from './state/app';

const initial = appStore.get();
afterEach(() => appStore.set(() => initial));

it('直接进入起始页再返回首页时，有历史任务不显示空任务提示，真正空列表仍保留添加指引', () => {
  const task: Task = { id: 'existing', projectId: 'project', groupId: null, title: '已有任务', prompt: '合成内容', status: 'review',
    permission: 'readonly', agent: 'fake', model: null, effort: null, autoAllowLowRisk: false, autoMergeOnPass: false,
    lastActivityAt: 1, createdAt: 1, updatedAt: 1 };
  appStore.set((state) => ({ ...state, tasks: { existing: task } }));
  const existing = renderToStaticMarkup(createElement(Home));
  expect(existing).toContain('选择一个任务，或新建任务');
  expect(existing).not.toContain('还没有任务');
  expect(existing).toContain('新建任务</button>');
  appStore.set((state) => ({ ...state, tasks: {}, projects: [] }));
  const empty = renderToStaticMarkup(createElement(Home));
  expect(empty).toContain('还没有任务');
  expect(empty).toContain('先添加一个项目文件夹');
});
