import { defineGame, requirePlayer, roster, shuffle, type GameState } from "../core";

interface Module {
  title: string;
  prompt: string;
  cards: string[];
  clues: string[];
  answer: string;
  answerLabel: string;
}

export interface DefuseState extends GameState {
  modules: Module[];
  stage: number;
  mistakes: number;
  startedAt: number;
  endedAt?: number;
  outcome?: "success" | "mistakes" | "timeout";
  history: string[];
}

function finish(state: DefuseState, outcome: DefuseState["outcome"], now: number) {
  state.status = "finished";
  state.outcome = outcome;
  state.endedAt = now;
  delete state.deadline;
}

export const game = defineGame<DefuseState>({
  id: "defuse",
  minPlayers: 1,
  maxPlayers: 6,
  create(players, context) {
    if (players.length < 1 || players.length > 6 || new Set(players.map(p => p.id)).size !== players.length) {
      throw new Error("默契拆弹需要1～6位不同玩家。");
    }
    const colors = shuffle(["红", "黄", "蓝", "绿", "白", "紫"], context.randomInt);
    const wire = context.randomInt(6);
    const digits = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9], context.randomInt).slice(0, 3);
    const [a, b, c] = digits;
    const symbols = ["★ 星星", "☾ 月亮", "☀ 太阳", "⚡ 闪电"];
    const order = shuffle([1, 2, 3, 4], context.randomInt);
    const symbolName = (id: number) => symbols[id - 1];
    const modules: Module[] = [
      {
        title: "模块一 · 六色线路",
        prompt: "只有一根线路可以安全剪断。汇总线索，找出它。",
        cards: colors.map((color, i) => `${i + 1} · ${color}线`),
        clues: shuffle([
          ...colors.filter((_, i) => i !== wire).map(color => `${color}线不能剪。`),
          `安全线路的编号是${(wire + 1) % 2 ? "奇" : "偶"}数。`
        ], context.randomInt),
        answer: String(wire + 1),
        answerLabel: `${wire + 1}号${colors[wire]}线`
      },
      {
        title: "模块二 · 三位密码",
        prompt: "密码由三个不同的1～9数字组成。根据线索，按顺序输入。",
        cards: ["① ?", "② ?", "③ ?"],
        clues: shuffle([
          `第一位与第二位的和是 ${a + b}。`,
          `第二位与第三位的和是 ${b + c}。`,
          `第一位与第三位的和是 ${a + c}。`,
          `三位数字的总和是 ${a + b + c}。`,
          `第一位比第二位${a > b ? "大" : "小"}。`,
          `第三位是${c % 2 ? "奇" : "偶"}数。`
        ], context.randomInt),
        answer: digits.join(""),
        answerLabel: digits.join("")
      },
      {
        title: "模块三 · 符号排序",
        prompt: "按线索排列四个符号，输入对应的四位编号，每个编号只用一次。",
        cards: symbols.map((symbol, i) => `${i + 1} · ${symbol}`),
        clues: shuffle([
          `${symbolName(order[0])}在${symbolName(order[1])}前面。`,
          `${symbolName(order[1])}在${symbolName(order[2])}前面。`,
          `${symbolName(order[2])}在${symbolName(order[3])}前面。`,
          `${symbolName(order[0])}不在最后一位。`,
          `${symbolName(order[3])}不在第一位。`,
          `${symbolName(order[1])}与${symbolName(order[2])}相邻。`
        ], context.randomInt),
        answer: order.join(""),
        answerLabel: order.map(symbolName).join(" → ")
      }
    ];
    return {
      ...roster(players), status: "playing", modules, stage: 0, mistakes: 0,
      startedAt: context.now, deadline: context.now + 180_000, history: []
    };
  },
  act(state, playerId, action, context) {
    requirePlayer(state, playerId);
    if (context.now >= state.deadline!) throw new Error("拆弹时间已到，请等待结算。");
    if (action.type !== `solve-${state.stage}`) throw new Error("模块已切换，请查看当前线索后再操作。");
    const value = action.value;
    if (typeof value !== "string" || !(
      state.stage === 0 ? /^[1-6]$/.test(value) :
      state.stage === 1 ? /^[1-9]{3}$/.test(value) && new Set(value).size === 3 :
      /^[1-4]{4}$/.test(value) && new Set(value).size === 4
    )) throw new Error("请按要求提交：线路编号、三位不同的1～9数字，或不重复的四位符号编号。");
    const module = state.modules[state.stage];
    if (value !== module.answer) {
      state.mistakes++;
      state.history.push(`${state.names[playerId]}提交 ${value}，触发警报（${state.mistakes}/3）。`);
      if (state.mistakes === 3) finish(state, "mistakes", context.now);
      return;
    }
    state.history.push(`${state.names[playerId]}解除了${module.title}：${module.answerLabel}。`);
    state.stage++;
    if (state.stage === state.modules.length) finish(state, "success", context.now);
  },
  timeout(state, context) {
    if (state.status === "playing" && state.deadline !== undefined && context.now >= state.deadline) {
      finish(state, "timeout", state.deadline);
    }
  },
  display(state, viewerId) {
    const active = state.status === "playing";
    const viewerIndex = state.playerIds.indexOf(viewerId);
    const canPlay = active && viewerIndex >= 0;
    const module = state.modules[Math.min(state.stage, state.modules.length - 1)];
    const personalClues = canPlay ? module.clues.flatMap((clue, i) =>
      i % state.playerIds.length === viewerIndex ? [{ label: `线索 ${i + 1}`, value: clue }] : []
    ) : [];
    return {
      title: active ? module.title : state.outcome === "success" ? "拆弹成功！全员安全。" : "拆弹失败，再试一次。",
      subtitle: state.playerIds.length === 1 ? "单人挑战 · 全部线索由你掌握" : "合作挑战 · 分享各自的线索，任何队员都可以操作",
      prompt: active ? module.prompt : `已解除 ${state.stage}/3 个模块，累计 ${state.mistakes}/3 次失误。`,
      progress: `已解除 ${state.stage}/3 · 失误 ${state.mistakes}/3`,
      cards: active ? module.cards : ["线路", "密码", "符号"].map((name, i) => `${i < state.stage ? "✓" : "×"} ${name}`),
      notice: canPlay
        ? state.playerIds.length === 1 ? "下方是全部六条线索。想清楚再提交，三个模块共用三次失误机会。"
          : `你拿到了 ${personalClues.length} 条私有线索。请当面或通过语音告诉队友；其他线索在他们的屏幕上。`
        : active ? "观战者可以看拆弹进度，私有线索仅对本局队员开放。" : "房主可以重新开局，挑战一组新谜题。",
      rows: active ? personalClues : state.modules.map((item, i) => ({
        label: `${i < state.stage ? "已解除" : "未解除"} · ${item.title}`,
        value: item.answerLabel, highlight: i < state.stage
      })),
      choices: canPlay && state.stage === 0 ? module.cards.map((label, i) => ({
        id: "solve-0", label: `剪断 ${label}`, value: String(i + 1)
      })) : [],
      input: canPlay && state.stage > 0 ? {
        id: `solve-${state.stage}`, label: state.stage === 1 ? "输入三位密码" : "输入四位符号编号",
        type: "text" as const, maxLength: state.stage === 1 ? 3 : 4,
        placeholder: state.stage === 1 ? "三个不同的1～9数字" : "1～4排列，例如2413"
      } : undefined,
      deadline: active ? state.deadline : undefined,
      result: active ? undefined : `${state.outcome === "success" ? "配合完美，炸弹已解除" : state.outcome === "timeout" ? "三分钟已到，拆弹失败" : "触发三次警报，拆弹失败"}。用时 ${Math.ceil(((state.endedAt ?? state.startedAt) - state.startedAt) / 1000)} 秒。`,
      history: state.history
    };
  }
});
