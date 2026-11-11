import type { GameMeta } from "../../../../../packages/games/core";

export const meta: GameMeta = {
  id: "thirty-one",
  title: "别数到31",
  subtitle: "多说一个，还是留一手？把31留给下一位。",
  category: "行酒令",
  minPlayers: 2,
  maxPlayers: 10,
  duration: "1～3分钟",
  icon: "🔢",
  rules: [
    "从1开始按座次轮流，每次选择连续报1、2或3个数字，系统自动接续报数。",
    "报到31的人本局失败；不能越过31，接近终点时超出的选项会禁用。",
    "每回合30秒，超时当前玩家失败。本局结束后房主可重新开局。",
    "新局先手按入座顺序轮换；后来加入的朋友先观战，下一局参与。",
    "服务器同步数字和回合，所有报数公开可见，不规定饮酒量。"
  ]
};
