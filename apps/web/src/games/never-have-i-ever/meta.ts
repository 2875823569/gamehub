import type { GameMeta } from "../../../../../packages/games/core";

export const meta: GameMeta = {
  id: "never-have-i-ever",
  title: "我从来没有",
  subtitle: "一个小经历，打开一群人的故事。",
  category: "行酒令",
  minPlayers: 3,
  maxPlayers: 10,
  duration: "3～7分钟",
  icon: "🙋",
  rules: [
    "每局随机8道生活经历题，每题45秒，选择做过、没做过或跳过。",
    "提交后不能修改；全员提交或时间到才统一揭晓，超时自动跳过。",
    "做过累计1次经历，跳过单独记录。经历数不分高低，没有惩罚。",
    "揭晓10秒后自动下一题，房主可提前推进。第8题揭晓后结束。",
    "后来加入的朋友观战，下一局参与；参赛者退出或离线满60秒会中止本局。"
  ]
};
