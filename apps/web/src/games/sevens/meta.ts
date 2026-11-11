import type { GameMeta } from "../../../../../packages/games/core";

export const meta: GameMeta = {
  id: "sevens",
  title: "逢七过",
  subtitle: "数到嘴边，突然刹车。看看谁的反应更快。",
  category: "行酒令",
  minPlayers: 3,
  maxPlayers: 10,
  duration: "约1～5分钟",
  icon: "⑦",
  rules: [
    "3～10人，从1开始按座位顺序轮流报数。每局先手顺移一位。",
    "7的倍数或数字中包含7时点击“过”，其他数字点击“报数”。不包含11、22等额外规则。",
    "每人每次8秒。选错或超时，本局立即结束；正确则轮到下一位。",
    "连续完成到100即全员通关。后来加入者观战，房主可在结束后重开。"
  ]
};
