import type { GameMeta } from "../../../../../packages/games/core";

export const meta: GameMeta = {
  id: "truth-or-dare",
  title: "真心话大冒险",
  subtitle: "说一个小故事，或者接受一份轻松挑战。",
  category: "行酒令",
  minPlayers: 2,
  maxPlayers: 10,
  duration: "约 5～15 分钟",
  icon: "✦",
  rules: [
    "每人轮流玩两次。30秒内选择真心话或大冒险，也可以直接跳过。",
    "真心话在90秒内提交文字答案，全房间可见；大冒险由本人点击“已完成”。",
    "每回合可以换题两次，换题不重置倒计时；不想参与的题目随时跳过。",
    "每次完成或跳过后展示8秒，房主也可以提前进入下一位。",
    "完成互动记1次，跳过不扣分；每人两轮后展示全场统计。"
  ]
};
