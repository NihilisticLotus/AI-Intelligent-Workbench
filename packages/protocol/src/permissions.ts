import { z } from 'zod';

export const PermissionRuleTool = z.enum(['shell','edit','read','any']);
export const PermissionRuleDraft = z.object({
  id:z.string().min(1).max(64).optional(), action:z.enum(['allow','ask','deny']), tool:PermissionRuleTool,
  match:z.string().min(1).max(2000).nullable(), path:z.string().min(1).max(2000).nullable(),
}).strict();
export type PermissionRuleDraft = z.infer<typeof PermissionRuleDraft>;
export const PermissionRule = PermissionRuleDraft.extend({
  id:z.string(),projectId:z.string(),ord:z.number().int().nonnegative(),source:z.enum(['manual','always_allow']),createdAt:z.number(),
});
export type PermissionRule = z.infer<typeof PermissionRule>;
export const PermissionRuleSet = z.object({projectId:z.string(),revision:z.number().int().nonnegative(),items:z.array(PermissionRule),alwaysDenied:z.array(z.string())});
export type PermissionRuleSet = z.infer<typeof PermissionRuleSet>;
export const PutPermissionRulesBody = z.object({revision:z.number().int().nonnegative(),items:z.array(PermissionRuleDraft).max(200)}).strict();
export type PutPermissionRulesBody = z.infer<typeof PutPermissionRulesBody>;
/** 仅可信适配层构造；不接受模型传入自动放行决定。 */
export const PermissionOperation = z.object({
  tool:PermissionRuleTool,command:z.string().max(32000).nullable(),paths:z.array(z.string().max(4096)).max(100),
  complete:z.boolean(),deletion:z.boolean().default(false),
});
export type PermissionOperation = z.infer<typeof PermissionOperation>;
export const PermissionContext = z.object({projectId:z.string(),root:z.string(),original:z.string(),level:z.enum(['readonly','ask','workspace','full']),isolated:z.boolean()});
export type PermissionContext = z.infer<typeof PermissionContext>;
export const PermissionEvaluation = z.object({action:z.enum(['allow','ask','deny']),reason:z.string(),ruleId:z.string().optional(),safeScope:z.boolean()});
export type PermissionEvaluation = z.infer<typeof PermissionEvaluation>;
export const PermissionRulePreview = z.object({revision:z.number().int().nonnegative(),rule:PermissionRuleDraft,label:z.string(),insertBefore:z.string().optional()});
export type PermissionRulePreview = z.infer<typeof PermissionRulePreview>;
export const AlwaysAllowConfirmation = z.object({revision:z.number().int().nonnegative()}).strict();
export type AlwaysAllowConfirmation = z.infer<typeof AlwaysAllowConfirmation>;
