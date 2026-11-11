import { meta as kingsCup } from "../games/kings-cup/meta";
import { meta as neverHave } from "../games/never-have-i-ever/meta";
import { meta as truthDare } from "../games/truth-or-dare/meta";
import { meta as mostLikely } from "../games/most-likely-to/meta";
import { meta as wouldRather } from "../games/would-you-rather/meta";
import { meta as rideBus } from "../games/ride-the-bus/meta";
import { meta as numberBomb } from "../games/number-bomb/meta";
import { meta as sevens } from "../games/sevens/meta";
import { meta as categories } from "../games/categories/meta";
import { meta as thirtyOne } from "../games/thirty-one/meta";
import type { GameMeta } from "../../../../packages/games/core";
import { meta as defuse } from "../games/defuse/meta";

export const gameCategories = ["行酒令", "其他"] as const;
export type GameCategory = typeof gameCategories[number];

const metadata: GameMeta[] = [
  {
    id: "liars-dice",
    title: "吹牛骰子",
    subtitle: "藏好你的点数，看穿朋友的演技。",
    category: "行酒令",
    minPlayers: 2,
    maxPlayers: 6,
    icon: "⚄",
    rules: [],
    duration: "一局几分钟",
  },
  kingsCup, neverHave, truthDare, mostLikely, wouldRather, rideBus, numberBomb, sevens, categories, thirtyOne, defuse
];
export const games = metadata.map(game => ({
  ...game,
  players: game.minPlayers === 1 ? `1–${game.maxPlayers} 人 · 可单人` : `${game.minPlayers}–${game.maxPlayers} 人`, available: true
}));
export function findGame(id = "liars-dice") { return games.find(game => game.id === id) ?? games[0]; }
