/**
 * 从模型回复里抠出 JSON。
 *
 * 不要求模型「只回 JSON」就真的只回 JSON：围栏、开场白、结尾总结都见过。
 * 也不为它加 `response_format`——不是每家接口都认，报的还是 400。
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1] : text).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const from = body.search(/[[{]/);
    const to = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
    if (from < 0 || to <= from) {
      throw new Error('AI 的回复里没有 JSON——多半是它多说了几句闲话；再试一次，还不行就换个模型');
    }
    try {
      parsed = JSON.parse(body.slice(from, to + 1));
    } catch (e) {
      throw new Error(`AI 回复里的 JSON 解析失败：${(e as Error).message}`);
    }
  }

  // 包了一层：`{"note": {...}}` / `{"draft": {...}}`。只有一个键、值仍是对象时才拆，
  // 多个键说不清该取哪个。
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const vals = Object.values(parsed as Record<string, unknown>);
    if (vals.length === 1 && vals[0] && typeof vals[0] === 'object') return vals[0];
  }
  return parsed;
}
