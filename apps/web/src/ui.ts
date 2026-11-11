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
      <li><b>每人 5 颗，输家下局先喊</b><p>2～6 人。首局随机，以后上一局输家先喊；输家已离房就按原座次顺延。首叫至少等于本局人数。</p></li>
      <li><b>顺子计零，围骰加成</b><p>五颗点数各不相同（如 23456、13456）整手计零，包括 1。万能模式下，22221 算 6 个 2；22222 算 7 个 2。11111 在万能模式下可算 7 个任意点；斋时只算 7 个 1。</p></li>
      <li><b>点数大小：2＜3＜4＜5＜6＜1</b><p>同模式须增加数量，或同数量增加点数。“4 个 6 斋”后可以叫“4 个 1”。叫数最多为人数 ×7。</p></li>
      <li><b>一个「斋」按钮，就能叫斋</b><p>普通模式 1 万能。叫斋后 1 不再百搭；从普通转斋，数量最低为上一手的一半向上取整。叫 1 自动为斋。斋之后只能继续斋或飞。</p></li>
      <li><b>飞：翻倍回到万能模式</b><p>从斋切到「飞」，数量至少翻倍，且不能叫 1。例如 4 个 1 后可叫 8 个 2 飞。含 1 的围骰在斋时只按实际点数计数；天然全围仍按 7 计。</p></li>
      <li><b>开、劈与反劈</b><p>轮到自己可以直接开，结算 ×1。任意本局玩家都可劈其他人的最后叫点，暂停叫点、暂不揭骰；被劈者接受后开骰 ×2，或反劈后开骰 ×4，只反一次。倍数仅作结果展示。</p></li>
      <li><b>一人输，整局结束</b><p>有效数量达到叫数，开骰／劈的人输；不足则叫点的人输。结果展示每手的有效贡献和倍数。</p></li>
    </ol>
    <div class="notice">叫点和回应劈均不倒计时；掉线可在 60 秒内重连，超时判负。主动离开也算弃权，结算 ×1；未完成的劈随本局结束取消。</div>
    <button class="button primary full" data-action="close-modal">懂了，准备开玩 ${arrow}</button>`;
}
