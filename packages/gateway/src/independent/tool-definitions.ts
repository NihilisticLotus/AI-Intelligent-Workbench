// 模型声明由协议规格生成；旧版本保持原定义，以免改变历史私有续传的工具指纹。
import { z } from 'zod';
import {
  IndependentCommandSpec, IndependentFileListSpec, IndependentFileReadSpec, IndependentFileSearchSpec,
  IndependentFileWriteSpec, IndependentProjectRulesSpec, IndependentCreateFileArguments, IndependentReplaceTextArguments,
  type IndependentModelToolDefinition, type IndependentFileToolVersion,
} from '@aic/protocol';

const tool = (name: string, description: string, schema: z.ZodType): IndependentModelToolDefinition => {
  const { $schema: _version, ...inputSchema } = z.toJSONSchema(schema, { io: 'input' });
  return { name, description, parameters: { ...inputSchema, type: 'object' } };
};

export function independentModelTools(version: IndependentFileToolVersion = 'combined_v1'): IndependentModelToolDefinition[] {
  return [
    tool('list_files', '列出项目中的普通文件；结果有容量与时间限制。', IndependentFileListSpec),
    tool('read_file', '读取项目 UTF-8 文本，返回内容与文件摘要。', IndependentFileReadSpec),
    tool('search_files', '在项目普通文本内逐行搜索。', IndependentFileSearchSpec),
    tool('read_rules', '读取目标文件所适用的 AGENTS.md 规则。', IndependentProjectRulesSpec),
    ...(version === 'separate_v2' ? [
      tool('create_file', '申请创建不存在的项目文件。提供相对路径 path、完整文本 content 和是否创建父目录 createParents；用户批准后才写入，不覆盖已有文件。', IndependentCreateFileArguments),
      tool('replace_text', '申请替换项目文件中唯一匹配的文本。先用 read_file 取得原始 SHA-256，提供 path、expectedHash、oldText 和 newText；用户批准后重新核对摘要。', IndependentReplaceTextArguments),
    ] : [tool('write_file', '申请创建文件或唯一文本替换；用户批准后核对原内容再修改。', IndependentFileWriteSpec)]),
    tool('command', '申请执行命令。必须提供绝对可执行文件与参数数组；用户逐次批准，无系统沙箱。', IndependentCommandSpec),
  ];
}
