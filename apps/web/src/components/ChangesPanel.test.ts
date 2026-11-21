import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';
import type { Task, WorkspaceChanges } from '@aic/protocol';
import { ChangesPanel } from './ChangesPanel';
import { changeFocus } from '../state/details';

const task: Task = { id:'t', projectId:'p', groupId:null, title:'任务', prompt:'', status:'review', permission:'ask', agent:'fake',
  model:null, effort:null, autoAllowLowRisk:false, autoMergeOnPass:false, lastActivityAt:1, createdAt:1, updatedAt:1,
  workspace:{kind:'copy',path:'D:/work',state:'ready',branch:null,baseBranch:null,baseRef:null} };
const changes: WorkspaceChanges = { files:[{path:'a.txt',status:'M',added:1,removed:0,binary:false,tooLarge:false,beforeSize:1,afterSize:2}],added:1,removed:0 };
const render = () => renderToStaticMarkup(createElement(ChangesPanel,{task,changes,error:null,refresh:()=>{}}));
afterEach(() => changeFocus.set(() => null));

it('目标缺失时给出提示并隐藏还原，另一任务的定位不会影响当前面板', () => {
  changeFocus.set(() => ({taskId:task.id,path:'missing/a.txt'}));
  const missing=render();
  expect(missing).toContain('尚未出现在实际改动中');
  expect(missing).not.toContain('>还原文件</button>');
  expect(missing).toContain('aria-pressed="false"');
  changeFocus.set(() => ({taskId:'other',path:'missing/a.txt'}));
  expect(render()).toContain('>还原文件</button>');
});
