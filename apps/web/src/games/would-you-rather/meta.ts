import type { GameMeta } from "../../../../../packages/games/core";

export const meta: GameMeta = {
  id: "would-you-rather",
  title: "你宁愿选哪个",
  subtitle: "选海边还是山里？站个队，看看谁和你最默契。",
  category: "行酒令",
  minPlayers: 3,
  maxPlayers: 10,
  duration: "约5～8分钟",
  icon: "⇄",
  rules: [
    "每局8道不同的二选一题。每题45秒，秘密选A、B或跳过，提交后不能修改。",
    "全员提交或时间到，统一揭晓每个人的阵营；超时未答自动跳过。",
    "多数阵营各得1分，平票都不得分；有效作答者全票同选则各得1分，跳过不得分。",
    "揭晓10秒自动进入下一题，房主也可提前继续。第8题后比较总分，同分并列获胜。",
    "本游戏是积分版聚会改编，不规定饮酒量，所有题目均可跳过。"
  ]
};
