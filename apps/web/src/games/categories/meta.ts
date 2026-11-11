import type { GameMeta } from "../../../../../packages/games/core";

export const meta: GameMeta = {
  id: "categories",
  title: "分类接龙",
  subtitle: "水果、电影、城市……脑海里的下一词，别和朋友撞车。",
  category: "行酒令",
  minPlayers: 3,
  maxPlayers: 10,
  duration: "约3～8分钟",
  icon: "🍋",
  rules: [
    "房主选择类别，每人按顺序在30秒内说出一个同类词语；新局首位轮换。",
    "空格、大小写和全角差异会被视为相同词，重复、超时或认输即本局失败。",
    "新词公开后大家讨论，由房主在15秒内判定是否符合类别；未裁定则自动接受。",
    "接受的词每个加1分，三圈全部接完则全员通关。系统不自动判断词义。",
    "后来加入者观战；结束后房主可再开一局。"
  ]
};
