import { game as kingsCup } from "./kings-cup/rules";
import { game as neverHave } from "./never-have-i-ever/rules";
import { game as truthDare } from "./truth-or-dare/rules";
import { game as mostLikely } from "./most-likely-to/rules";
import { game as wouldRather } from "./would-you-rather/rules";
import { game as rideBus } from "./ride-the-bus/rules";
import { game as numberBomb } from "./number-bomb/rules";
import { game as sevens } from "./sevens/rules";
import { game as categories } from "./categories/rules";
import { game as thirtyOne } from "./thirty-one/rules";
import type { GameDefinition } from "./core";
import { game as defuse } from "./defuse/rules";

export const partyGames: ReadonlyMap<string, GameDefinition> = new Map(
  [kingsCup, neverHave, truthDare, mostLikely, wouldRather, rideBus, numberBomb, sevens, categories, thirtyOne, defuse]
    .map(game => [game.id, game])
);
