import type { GameMeta } from "../../../../../packages/games/core";

export const meta: GameMeta = {
  id: "number-bomb",
  title: "数字炸弹",
  subtitle: "范围越来越小，下一位会不会就是你？",
  category: "行酒令",
  minPlayers: 2,
  maxPlayers: 10,
  duration: "2～5分钟",
  icon: "💣",
  rules: [
    "服务器在1～100中藏一个数字，大家按顺序猜，命中者本局失败。",
    "每次只能猜当前范围内的整数，两端都能选；安全数字会缩小下一位的范围。",
    "每回合30秒，超时也会失败。服务器决定答案与计时。",
    "炸弹仅在结束时揭晓。下一局首位轮换；后来加入的朋友先观战。",
    "不规定饮酒量，用胜负享受这一局心跳。"
  ]
};
