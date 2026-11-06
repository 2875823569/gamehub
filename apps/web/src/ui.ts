export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function dice(value: number, className = ""): string {
  const positions: Record<number, number[]> = {
    1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8]
  };
  return `<span class="die ${value === 1 ? "wild" : ""} ${className}" role="img" aria-label="${value} 点">${Array.from({ length: 9 }, (_, index) =>
    `<i class="${positions[value]?.includes(index) ? "pip" : ""}"></i>`).join("")}</span>`;
}

export function avatar(name: string, index: number, extra = ""): string {
  return `<span class="avatar color-${index % 6} ${extra}" aria-hidden="true">${escapeHtml([...name][0] || "?")}</span>`;
}

export const arrow = '<span aria-hidden="true">↗</span>';
export const brand = `<a href="/" class="brand" aria-label="玩伴首页"><span class="brand-icon">${dice(5)}</span><span>玩伴<small>PLAYROOM</small></span></a>`;

export function rules(): string {
  return `<span class="eyebrow">HOW TO PLAY</span><h2>一点运气，<br>一点演技。</h2>
    <ol class="rules-list">
      <li><b>每人 5 颗，只看自己的</b><p>2～6 人开局，随机一人先叫。1 点是万能点，可以算作任意 2～6 点。</p></li>
      <li><b>猜全场，轮流往上叫</b><p>例如“4 个 3”，表示全场至少有 4 颗 3 点（包含 1 点）。下家必须增加数量，或数量不变、增加点数。</p></li>
      <li><b>不信上一家？轮到你就开</b><p>数量达到叫数，开骰的人输；数量不足，叫点的人输。出现一个输家，整局结束。</p></li>
    </ol>
    <div class="notice">只叫 2～6 点，不使用“叫斋”。正常回合不限时；掉线可在 60 秒内重连，超时判负。主动离开本局也算弃权。</div>
    <button class="button primary full" data-action="close-modal">懂了，准备开玩 ${arrow}</button>`;
}
