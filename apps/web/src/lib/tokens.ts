/** 统一用 k 表示千位，最多一位小数；未知值不能冒充零。 */
export function formatTokens(value: number | null | undefined): string {
  if (value == null) return '未报告';
  return value >= 1000 ? (value / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(value);
}
