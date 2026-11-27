// 第 2.4 步技能库共享协议单测
import { describe, expect, it } from 'vitest';
import {
  CreateSkillBody, ImportLocalSkillsBody, ScanLocalSkillsBody, SkillDetail, SkillLocalScanResult, TaskSkillsState,
} from './skills';

describe('2.4 能力中心（下）技能库协议', () => {
  it('CreateSkillBody / ScanLocalSkillsBody / ImportLocalSkillsBody 严格校验必填字段与默认值', () => {
    const body = CreateSkillBody.parse({
      name: '策划案检查清单',
      markdown: '# 策划案检查清单\n1. 检查数值闭环',
    });
    expect(body.sourceKind).toBe('manual');
    expect(body.enabled).toBe(true);
    expect(body.approveRisks).toBe(false);
    expect(body.extraFiles).toEqual([]);

    expect(() => CreateSkillBody.parse({ markdown: '' })).toThrow();

    const scanBody = ScanLocalSkillsBody.parse({});
    expect(scanBody.sources).toEqual(['agents_public']);

    expect(() => ImportLocalSkillsBody.parse({ scanId: 'scan_1', items: [] })).toThrow();
  });

  it('SkillDetail、SkillLocalScanResult 与 TaskSkillsState 通过严格模式校验', () => {
    const detail = SkillDetail.parse({
      id: 'sk_1',
      slug: 'design-check',
      name: '策划案检查清单',
      description: '审阅策划文档时参考',
      version: '1.0',
      contentHash: 'a'.repeat(64),
      sourceKind: 'manual',
      sourceLabel: '手动新建',
      agents: [],
      enabled: true,
      requiresApproval: false,
      risksApproved: true,
      hasScripts: false,
      scriptFiles: [],
      files: [{ path: 'SKILL.md', kind: 'skill', size: 120 }],
      scan: {
        riskLevel: 'safe',
        hasScripts: false,
        scriptFiles: [],
        findings: [],
        scannedFiles: 1,
        scannedAt: 1000,
      },
      createdAt: 1000,
      updatedAt: 1000,
      markdown: '# 测试',
    });
    expect(detail.slug).toBe('design-check');

    const scanRes = SkillLocalScanResult.parse({
      scanId: 'scan_1',
      checkedSources: [{ sourceKind: 'agents_public', label: '公共目录', available: true, foundCount: 1 }],
      candidates: [{
        candidateId: 'cand_1',
        name: 'demo',
        slug: 'demo',
        description: '示例',
        version: '1.0',
        sourceKind: 'agents_public',
        sourceLabel: '公共目录',
        conflict: 'new',
        existingSkillId: null,
        contentHash: 'b'.repeat(64),
        filesCount: 1,
        hasScripts: false,
        scriptFiles: [],
        scan: { riskLevel: 'safe', hasScripts: false, scriptFiles: [], findings: [], scannedFiles: 1, scannedAt: 1000 },
      }],
    });
    expect(scanRes.candidates).toHaveLength(1);

    const taskSkills = TaskSkillsState.parse({
      taskId: 't_1',
      agent: 'independent',
      skills: [{
        id: 'sk_1',
        slug: 'design-check',
        name: '策划案检查清单',
        description: '审阅策划文档时参考',
        enabled: true,
        assigned: true,
        disabledForTask: false,
        activeForTask: true,
        riskLevel: 'safe',
        hasScripts: false,
        requiresApproval: false,
        risksApproved: true,
      }],
    });
    expect(taskSkills.skills[0]!.activeForTask).toBe(true);
  });
});
