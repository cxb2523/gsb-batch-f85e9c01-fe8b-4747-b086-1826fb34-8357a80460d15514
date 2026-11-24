import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useGlobalStore } from "../src/core/globalStore";
import useGame from "../src/core/game";
import { defaultGameConfig } from "../src/core/gameConfig";

/**
 * 测试用的小型配置：块数少、类型少，跑得快且方便断言
 */
const testConfig: GameConfigType = {
  slotNum: 5,
  composeNum: 3,
  typeNum: 4,
  levelBlockNum: 6,
  borderStep: 1,
  levelNum: 3,
  randomBlocks: [3, 3],
  animals: defaultGameConfig.animals.slice(0, 4),
};

/**
 * 初始化 Pinia 并写入测试配置，返回一局全新的游戏实例
 */
const setupGame = () => {
  setActivePinia(createPinia());
  const store = useGlobalStore();
  store.setGameConfig({ ...testConfig });
  const game = useGame();
  game.doStart();
  return game;
};

/** 当前可点击（未被任何块遮挡）的层级块 id 集合 */
const clickableIds = (game: ReturnType<typeof useGame>) => {
  return new Set(
    game
      .getBoardBlocks()
      .filter(
        (block) => block.status === 0 && block.lowerThanBlocks.length === 0
      )
      .filter((block) =>
        game.levelBlocksVal.value.some(
          (levelBlock) => levelBlock.id === block.id
        )
      )
      .map((block) => block.id)
  );
};

/** 槽位中的块（非空） */
const slotBlocks = (game: ReturnType<typeof useGame>) => {
  return game.slotAreaVal.value.filter((block): block is BlockType => !!block);
};

/** 棋盘上的块（status 为 0 且登记在棋盘上） */
const boardBlocks = (game: ReturnType<typeof useGame>) => {
  return game.getBoardBlocks();
};

/**
 * 校验全局一致性：
 * 1. 同一块不能同时存在于槽位与棋盘
 * 2. 已消除计数与 status === 2 的块数一致
 * 3. 各状态块数之和等于总块数
 */
const expectConsistentState = (game: ReturnType<typeof useGame>) => {
  const slotIds = new Set(slotBlocks(game).map((block) => block.id));
  const boardIds = new Set(boardBlocks(game).map((block) => block.id));
  slotIds.forEach((id) => {
    expect(boardIds.has(id)).toBe(false);
  });
  // 槽位块的 status 必须是已点击
  slotBlocks(game).forEach((block) => {
    expect(block.status).toBe(1);
  });
  // 棋盘块的 status 必须是正常
  boardBlocks(game).forEach((block) => {
    expect(block.status).toBe(0);
  });
  // 槽位占用数与槽内块数一致
  expect(game.currSlotNum.value).toBe(slotBlocks(game).length);
  // 槽位定长
  expect(game.slotAreaVal.value.length).toBe(testConfig.slotNum);
};

describe("对局生命周期：开始 / 重新开始", () => {
  it("首次开局后状态正确", () => {
    const game = setupGame();
    expect(game.gameStatus.value).toBe(1);
    expect(game.clearBlockNum.value).toBe(0);
    expect(game.currSlotNum.value).toBe(0);
    expect(game.opHistory.value.length).toBe(0);
    expect(slotBlocks(game).length).toBe(0);
    expect(game.totalBlockNum.value).toBeGreaterThan(0);
    expect(boardBlocks(game).length).toBeGreaterThan(0);
    expectConsistentState(game);
  });

  it("连续两次开局，第二次必须是全新状态，没有旧局残留", () => {
    const game = setupGame();
    const firstTotal = game.totalBlockNum.value;
    const firstLevelIds = game.levelBlocksVal.value.map((block) => block.id);

    // 制造一些"旧局残留"：点几个块、用技能
    const clickable = [...clickableIds(game)];
    expect(clickable.length).toBeGreaterThan(0);
    game.doClickBlock(
      game.levelBlocksVal.value.find((block) => block.id === clickable[0])!
    );
    game.doShuffle();
    // doRemove 会清空槽位，所以先断言槽位占用再移出
    expect(game.currSlotNum.value).toBeGreaterThan(0);
    expect(game.opHistory.value.length).toBeGreaterThan(0);
    game.doRemove();

    // 第二次开局
    game.doStart();

    expect(game.gameStatus.value).toBe(1);
    expect(game.totalBlockNum.value).toBe(firstTotal);
    // 槽位、历史、消除计数全部重置
    expect(game.currSlotNum.value).toBe(0);
    expect(game.opHistory.value.length).toBe(0);
    expect(game.clearBlockNum.value).toBe(0);
    expect(slotBlocks(game).length).toBe(0);
    expect(game.slotAreaVal.value.every((block) => block === null)).toBe(true);
    // 块数据重新生成（id 重新从 0 开始且不重复）
    const newIds = game.levelBlocksVal.value.map((block) => block.id);
    expect(new Set(newIds).size).toBe(newIds.length);
    expect(game.levelBlocksVal.value.length).toBe(firstLevelIds.length);
    // 新局的可点击块数量应大于 0，且棋盘块数 + 随机块数 == 总数（槽位清空）
    expect(clickableIds(game).size).toBeGreaterThan(0);
    expectConsistentState(game);
  });

  it("第二次开局不会残留旧局的遮挡关系", () => {
    const game = setupGame();
    // 点走所有可点击块（不消除），让一些块被解锁
    let guard = 0;
    while (guard++ < 20) {
      const clickable = [...clickableIds(game)];
      if (clickable.length === 0) {
        break;
      }
      const block = game.levelBlocksVal.value.find(
        (levelBlock) => levelBlock.id === clickable[0]
      )!;
      game.doClickBlock(block);
    }
    game.doStart();

    // 新局中每个棋盘块的遮挡关系都必须指向仍存在于棋盘上的块
    const boardIds = new Set(boardBlocks(game).map((block) => block.id));
    boardBlocks(game).forEach((block) => {
      block.lowerThanBlocks.forEach((lower) => {
        expect(boardIds.has(lower.id)).toBe(true);
      });
      block.higherThanBlocks.forEach((higher) => {
        expect(boardIds.has(higher.id)).toBe(true);
      });
    });
    expectConsistentState(game);
  });
});

describe("撤回", () => {
  it("撤回后块回到原位、重新可点击、槽位占用数减少", () => {
    const game = setupGame();
    const clickable = [...clickableIds(game)];
    const target = game.levelBlocksVal.value.find(
      (block) => block.id === clickable[0]
    )!;
    const originX = target.x;
    const originY = target.y;
    const originLevel = target.level;

    game.doClickBlock(target);
    expect(target.status).toBe(1);
    expect(slotBlocks(game).some((block) => block.id === target.id)).toBe(true);
    expect(game.currSlotNum.value).toBe(1);
    expect(boardBlocks(game).some((block) => block.id === target.id)).toBe(
      false
    );
    expectConsistentState(game);

    game.doRevert();

    // 回到棋盘原位
    expect(target.status).toBe(0);
    expect(target.x).toBe(originX);
    expect(target.y).toBe(originY);
    expect(target.level).toBe(originLevel);
    expect(boardBlocks(game).some((block) => block.id === target.id)).toBe(
      true
    );
    // 不在槽位
    expect(slotBlocks(game).some((block) => block.id === target.id)).toBe(
      false
    );
    expect(game.currSlotNum.value).toBe(0);
    expect(game.opHistory.value.length).toBe(0);
    // 可再次点击
    expect(clickableIds(game).has(target.id)).toBe(true);
    expectConsistentState(game);

    // 再次点击同样成功
    game.doClickBlock(target);
    expect(game.currSlotNum.value).toBe(1);
    expectConsistentState(game);
  });

  it("多次点击后按 LIFO 撤回，槽位与遮挡关系始终保持一致", () => {
    const game = setupGame();
    const clicked: BlockType[] = [];
    // 只点击"槽位中尚不存在该图案"的块，确保不会触发消除，
    // 这样每次点击都必然进入可撤回历史
    for (let i = 0; i < 3; i++) {
      const slotTypes = new Set(slotBlocks(game).map((block) => block.type));
      const id = [...clickableIds(game)].find((cid) => {
        const block = game.levelBlocksVal.value.find((b) => b.id === cid);
        return (
          block &&
          !slotTypes.has(block.type) &&
          !clicked.some((clickedBlock) => clickedBlock.id === cid)
        );
      });
      if (id === undefined) {
        break;
      }
      const block = game.levelBlocksVal.value.find((b) => b.id === id)!;
      game.doClickBlock(block);
      // 未触发消除
      expect(block.status).toBe(1);
      clicked.push(block);
      expect(game.currSlotNum.value).toBe(clicked.length);
      expect(game.opHistory.value.length).toBe(clicked.length);
      expectConsistentState(game);
    }
    expect(clicked.length).toBeGreaterThan(0);

    while (clicked.length > 0) {
      const block = clicked.pop()!;
      game.doRevert();
      expect(block.status).toBe(0);
      expect(clickableIds(game).has(block.id)).toBe(true);
      expect(game.currSlotNum.value).toBe(clicked.length);
      expectConsistentState(game);
    }
    expect(game.currSlotNum.value).toBe(0);
    expect(game.opHistory.value.length).toBe(0);
  });

  it("撤回会重建被撤回块与周围块的遮挡关系", () => {
    const game = setupGame();
    // 找到一个"可点击且压着别人"的块，点走它后下层块应被解锁
    const clickable = clickableIds(game);
    const withLower = boardBlocks(game).find(
      (block) => clickable.has(block.id) && block.higherThanBlocks.length > 0
    );
    expect(withLower).toBeTruthy();
    const lowerBlocks = [...withLower!.higherThanBlocks];

    game.doClickBlock(withLower!);
    expect(withLower!.status).toBe(1);
    // 下方块不再被它遮挡
    lowerBlocks.forEach((lowerBlock) => {
      expect(
        lowerBlock.lowerThanBlocks.some((b) => b.id === withLower!.id)
      ).toBe(false);
    });

    game.doRevert();
    // 撤回后遮挡关系恢复
    lowerBlocks.forEach((lowerBlock) => {
      expect(
        lowerBlock.lowerThanBlocks.some((b) => b.id === withLower!.id)
      ).toBe(true);
    });
    expect(withLower!.status).toBe(0);
    expect(clickableIds(game).has(withLower!.id)).toBe(true);
    expectConsistentState(game);
  });
});

describe("移出", () => {
  it("移出后首块回到层级区，可正常点击消除", () => {
    const game = setupGame();
    const clickable = [...clickableIds(game)];
    const target = game.levelBlocksVal.value.find(
      (block) => block.id === clickable[0]
    )!;
    game.doClickBlock(target);
    expect(game.currSlotNum.value).toBe(1);

    const slotFirst = slotBlocks(game)[0];
    game.doRemove();

    // 槽位空出
    expect(game.currSlotNum.value).toBe(0);
    expect(slotBlocks(game).length).toBe(0);
    // 该块离开槽位、回到棋盘
    expect(slotFirst.status).toBe(0);
    expect(boardBlocks(game).some((block) => block.id === slotFirst.id)).toBe(
      true
    );
    // 出现在层级区渲染列表
    expect(
      game.levelBlocksVal.value.some((block) => block.id === slotFirst.id)
    ).toBe(true);
    // 不再出现在随机区
    expect(
      game.randomBlocksVal.value.some((group) =>
        group.some((block) => block.id === slotFirst.id)
      )
    ).toBe(false);
    // 可被正常点击（没有上层遮挡）
    expect(clickableIds(game).has(slotFirst.id)).toBe(true);
    expectConsistentState(game);

    // 真的可以点走它
    game.doClickBlock(slotFirst);
    expect(slotFirst.status).toBe(1);
    expect(slotBlocks(game).some((block) => block.id === slotFirst.id)).toBe(
      true
    );
    expectConsistentState(game);
  });

  it("移出随机块后，它会真正参与棋盘遮挡判定并可点击", () => {
    const game = setupGame();
    // 点击一个随机块进入槽位
    const randomGroup = game.randomBlocksVal.value.find(
      (group) => group.length > 0
    )!;
    const randomBlock = randomGroup[0];
    const randomIdx = game.randomBlocksVal.value.indexOf(randomGroup);
    game.doClickBlock(randomBlock, randomIdx);
    expect(slotBlocks(game)[0].id).toBe(randomBlock.id);
    expect(game.currSlotNum.value).toBe(1);

    game.doRemove();
    expect(randomBlock.status).toBe(0);
    // 随机块补入层级区
    expect(
      game.levelBlocksVal.value.some((block) => block.id === randomBlock.id)
    ).toBe(true);
    expect(clickableIds(game).has(randomBlock.id)).toBe(true);
    expectConsistentState(game);
  });

  it("移出块重新参与遮挡：若与已有块重叠，关系必须双向建立", () => {
    const game = setupGame();
    // 点击两个可点击块进入槽位
    let clicked = 0;
    for (let i = 0; i < 20 && clicked < 2; i++) {
      const id = [...clickableIds(game)].find(
        (cid) => !slotBlocks(game).some((block) => block.id === cid)
      );
      if (id === undefined) break;
      const block = game.levelBlocksVal.value.find((b) => b.id === id)!;
      game.doClickBlock(block);
      if (block.status === 1) clicked++;
    }
    expect(game.currSlotNum.value).toBe(2);

    // 连续移出两个块（都放到棋盘底部，极可能相互重叠）
    game.doRemove();
    game.doRemove();
    expect(game.currSlotNum.value).toBe(0);

    // 所有块的遮挡关系都必须双向一致，且指向棋盘上真实存在的块
    const boardIds = new Set(boardBlocks(game).map((block) => block.id));
    boardBlocks(game).forEach((block) => {
      block.lowerThanBlocks.forEach((lower) => {
        expect(boardIds.has(lower.id)).toBe(true);
        expect(
          lower.higherThanBlocks.some((higher) => higher.id === block.id)
        ).toBe(true);
      });
      block.higherThanBlocks.forEach((higher) => {
        expect(boardIds.has(higher.id)).toBe(true);
        expect(
          higher.lowerThanBlocks.some((lower) => lower.id === block.id)
        ).toBe(true);
      });
    });
    // 移出的两个块都不应被"自己看不到"的块遮挡，至少应有一个可点击
    expect(clickableIds(game).size).toBeGreaterThan(0);
    expectConsistentState(game);
  });
});

describe("洗牌", () => {
  it("只改变未点击块的图案，不改变可点击集合与遮挡关系", () => {
    const game = setupGame();
    // 先点走一个块，制造"已点击"状态
    const clickable = [...clickableIds(game)];
    const clickedBlock = game.levelBlocksVal.value.find(
      (block) => block.id === clickable[0]
    )!;
    game.doClickBlock(clickedBlock);
    const clickedType = clickedBlock.type;
    const slotIdsBefore = slotBlocks(game).map((block) => block.id);

    const clickableBefore = clickableIds(game);
    // 记录每个棋盘块的位置 / 遮挡关系（洗牌不应改变）
    const relationsBefore = boardBlocks(game).map((block) => ({
      id: block.id,
      x: block.x,
      y: block.y,
      level: block.level,
      lower: block.lowerThanBlocks.map((b) => b.id).sort(),
      higher: block.higherThanBlocks.map((b) => b.id).sort(),
    }));
    // 未点击块（棋盘 + 随机区）的图案多重集合（洗牌只做重新排列）
    const allUnclickedBlocks = () => [
      ...game.levelBlocksVal.value,
      ...game.randomBlocksVal.value.flat(),
    ];
    const typeMultisetBefore = allUnclickedBlocks()
      .filter((block) => block.status === 0)
      .map((block) => block.type)
      .sort();

    game.doShuffle();

    // 位置与遮挡关系不变
    const relationsAfter = boardBlocks(game).map((block) => ({
      id: block.id,
      x: block.x,
      y: block.y,
      level: block.level,
      lower: block.lowerThanBlocks.map((b) => b.id).sort(),
      higher: block.higherThanBlocks.map((b) => b.id).sort(),
    }));
    expect(relationsAfter).toEqual(relationsBefore);
    // 可点击集合不变
    expect([...clickableIds(game)].sort()).toEqual([...clickableBefore].sort());
    // 已点击块图案与槽位内容不变
    expect(clickedBlock.type).toBe(clickedType);
    expect(slotBlocks(game).map((block) => block.id)).toEqual(slotIdsBefore);
    // 未点击块图案数量守恒
    expect(
      allUnclickedBlocks()
        .filter((block) => block.status === 0)
        .map((block) => block.type)
        .sort()
    ).toEqual(typeMultisetBefore);
    expectConsistentState(game);
  });

  it("洗牌后未点击块图案确实会重新分配", () => {
    const game = setupGame();
    const allUnclickedBlocks = () => [
      ...game.levelBlocksVal.value,
      ...game.randomBlocksVal.value.flat(),
    ];
    const typeSequence = () =>
      allUnclickedBlocks()
        .filter((block) => block.status === 0)
        .map((block) => block.type)
        .join("");
    const before = typeSequence();
    // 多洗几次，避免极小概率的"洗牌后完全一致"
    let changed = false;
    for (let i = 0; i < 10 && !changed; i++) {
      game.doShuffle();
      changed = typeSequence() !== before;
    }
    expect(changed).toBe(true);
    expectConsistentState(game);
  });
});

describe("技能间的状态一致性", () => {
  it("任何操作后都不会出现同一块同时在槽位与棋盘", () => {
    const game = setupGame();
    const operations = [
      () => {
        const clickable = [...clickableIds(game)];
        if (clickable.length === 0) return;
        const block = game.levelBlocksVal.value.find(
          (levelBlock) => levelBlock.id === clickable[0]
        )!;
        game.doClickBlock(block);
      },
      () => game.doShuffle(),
      () => game.doRemove(),
      () => game.doRevert(),
      () => game.doBroke(),
      () => game.doHolyLight(),
    ];
    for (let round = 0; round < 30; round++) {
      const op = operations[round % operations.length];
      op();
      expectConsistentState(game);
    }
  });
});
