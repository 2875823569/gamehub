import type { GameMeta } from "../../../../../packages/games/core";

export const meta: GameMeta = {
  id: "most-likely-to",
  title: "谁最可能",
  subtitle: "朋友眼中的你，藏在下一次揭晓里。",
  category: "行酒令",
  minPlayers: 3,
  maxPlayers: 10,
  duration: "约5分钟",
  icon: "✦",
  rules: [
    "每局8题，针对“谁最可能……”秘密选择一位玩家，可以选自己或跳过。",
    "每题45秒；全员提交或时间到后统一揭晓。未提交视为跳过，提交后不可更改。",
    "只公布每位玩家的票数，不公布谁投给谁。最高票者成为聚光灯，并列者一起展示。",
    "揭晓10秒后进入下一题，房主也可提前推进；全部跳过时不产生聚光灯。",
    "8题结束后展示累计获票和聚光灯次数，统计仅供趣味回顾。"
  ]
};
