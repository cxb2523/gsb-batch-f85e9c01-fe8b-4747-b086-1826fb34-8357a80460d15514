/**
 * 游戏逻辑 V2（不固定 level）
 *
 * 对局生命周期（开始 / 重置）与所有技能操作共享同一份棋盘状态：
 * - 棋盘登记表 chessBoard：记录当前仍位于棋盘上的块
 * - 遮挡关系：由棋盘上的块统一定义（重叠且层级更高者压住层级更低者）
 * 任何技能执行后都会统一重建遮挡关系，保证槽位、计数与实际块状态一致。
 *
 * @author yupi https://github.com/liyupi
 */
import { useGlobalStore } from "./globalStore";
// @ts-ignore
import _ from "lodash";
import { ref, shallowRef, reactive } from "vue";

/** 每个块在棋盘上占用的格子数（宽 / 高） */
const BLOCK_SIZE = 3;

const useGame = () => {
  const globalStore = useGlobalStore();

  /** 始终读取当前最新的游戏配置，保证重新开局时按最新 gameConfig 生成 */
  const getGameConfig = (): GameConfigType => globalStore.gameConfig;

  // 游戏状态：0 - 初始化, 1 - 进行中, 2 - 失败结束, 3 - 胜利
  const gameStatus = ref(0);

  // 各层块（用于渲染层级区）
  const levelBlocksVal = ref<BlockType[]>([]);
  // 随机区块
  const randomBlocksVal = ref<BlockType[][]>([]);
  // 插槽区（定长，空位为 null）
  const slotAreaVal = ref<Array<BlockType | null>>([]);
  // 当前槽占用数
  const currSlotNum = ref(0);

  // 总块数
  const totalBlockNum = ref(0);

  // 已消除块数
  const clearBlockNum = ref(0);

  // 总共划分 24 x 24 的格子，每个块占 3 x 3 的格子，生成的起始 x 和 y 坐标范围均为 0 ~ 21
  const boxWidthNum = 24;
  const boxHeightNum = 24;

  // 每个格子的宽高
  const widthUnit = 14;
  const heightUnit = 14;

  // 保存整个 "棋盘" 的每个格子状态（下标为格子起始点横纵坐标）
  let chessBoard: ChessBoardUnitType[][] = [];

  // 保存所有块（包括随机块），每次开局重建
  let allBlocks: BlockType[] = [];

  // 操作历史（存储点击的块，按点击顺序）
  // 使用 shallowRef 避免深层代理，保证块对象引用与棋盘一致
  const opHistory = shallowRef<BlockType[]>([]);

  // region 技能相关

  const isHolyLight = ref(false);

  const canSeeRandom = ref(false);

  // endregion

  // 失败提示定时器（重新开局 / 撤回时需要取消，避免旧局提示串场）
  let loseTimer: ReturnType<typeof setTimeout> | null = null;

  const clearLoseTimer = () => {
    if (loseTimer !== null) {
      clearTimeout(loseTimer);
      loseTimer = null;
    }
  };

  /**
   * 初始化指定大小的棋盘
   */
  const initChessBoard = (width: number, height: number) => {
    chessBoard = new Array(width);
    for (let i = 0; i < width; i++) {
      chessBoard[i] = new Array(height);
      for (let j = 0; j < height; j++) {
        chessBoard[i][j] = {
          blocks: [],
        };
      }
    }
  };

  // 初始化棋盘
  initChessBoard(boxWidthNum, boxHeightNum);

  /**
   * 清空上一局遗留的全部状态
   *
   * 新开一局必须清空块数据、遮挡关系、操作历史、槽位与已消除计数，
   * 避免同一页面反复开局时出现旧局残留。
   */
  const resetGame = () => {
    clearLoseTimer();
    allBlocks = [];
    initChessBoard(boxWidthNum, boxHeightNum);
    opHistory.value = [];
    levelBlocksVal.value = [];
    randomBlocksVal.value = [];
    slotAreaVal.value = [];
    currSlotNum.value = 0;
    totalBlockNum.value = 0;
    clearBlockNum.value = 0;
    isHolyLight.value = false;
    canSeeRandom.value = false;
    gameStatus.value = 0;
  };

  /**
   * 获取当前仍在棋盘上的块（已去重）
   */
  const getBoardBlocks = (): BlockType[] => {
    const result: BlockType[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < boxWidthNum; i++) {
      for (let j = 0; j < boxHeightNum; j++) {
        const cellBlocks = chessBoard[i][j].blocks;
        for (let k = 0; k < cellBlocks.length; k++) {
          const block = cellBlocks[k];
          if (block.status !== 0 || seen.has(block.id)) {
            continue;
          }
          seen.add(block.id);
          result.push(block);
        }
      }
    }
    return result;
  };

  /**
   * 把块登记到棋盘（幂等）
   */
  const addBlockToBoard = (block: BlockType) => {
    const cell = chessBoard[block.x]?.[block.y];
    if (!cell) {
      return;
    }
    if (!cell.blocks.some((boardBlock) => boardBlock.id === block.id)) {
      cell.blocks.push(block);
    }
  };

  /**
   * 从棋盘移除块（幂等）
   */
  const removeBlockFromBoard = (block: BlockType) => {
    for (let i = 0; i < boxWidthNum; i++) {
      for (let j = 0; j < boxHeightNum; j++) {
        const cellBlocks = chessBoard[i][j].blocks;
        const idx = cellBlocks.findIndex(
          (boardBlock) => boardBlock.id === block.id
        );
        if (idx >= 0) {
          cellBlocks.splice(idx, 1);
        }
      }
    }
  };

  /**
   * 两个块是否在棋盘上存在重叠（每个块占 3 x 3 格）
   */
  const isOverlap = (a: BlockType, b: BlockType) => {
    return Math.abs(a.x - b.x) < BLOCK_SIZE && Math.abs(a.y - b.y) < BLOCK_SIZE;
  };

  /**
   * 根据当前棋盘状态重建所有块的遮挡关系
   *
   * 规则：重叠的块中层级更高者压住层级更低者（层级相同时按 id 稳定排序）。
   * 每次点击 / 撤回 / 移出后调用，保证可点击状态与棋盘一致。
   */
  const rebuildLevelRelations = () => {
    const blocks = getBoardBlocks();
    blocks.forEach((block) => {
      block.higherThanBlocks = [];
      block.lowerThanBlocks = [];
    });
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        const a = blocks[i];
        const b = blocks[j];
        if (!isOverlap(a, b)) {
          continue;
        }
        const aAbove =
          a.level > b.level || (a.level === b.level && a.id > b.id);
        if (aAbove) {
          // a 在上方，压住 b
          a.higherThanBlocks.push(b);
          b.lowerThanBlocks.push(a);
        } else {
          // b 在上方，压住 a
          b.higherThanBlocks.push(a);
          a.lowerThanBlocks.push(b);
        }
      }
    }
    // 触发视图更新
    levelBlocksVal.value = [...levelBlocksVal.value];
  };

  /**
   * 获取槽位中的非空块（按顺序）
   */
  const getSlotBlocks = (): BlockType[] => {
    return slotAreaVal.value.filter((block): block is BlockType => !!block);
  };

  /**
   * 用紧凑的块列表刷新槽位区，并同步槽占用数
   */
  const commitSlot = (blocks: BlockType[]) => {
    const slotNum = getGameConfig().slotNum;
    const padded: Array<BlockType | null> = new Array(slotNum).fill(null);
    blocks.slice(0, slotNum).forEach((block, index) => {
      padded[index] = block;
    });
    slotAreaVal.value = padded;
    currSlotNum.value = Math.min(blocks.length, slotNum);
  };

  /**
   * 游戏初始化
   */
  const initGame = () => {
    const config = getGameConfig();
    console.log("initGame", config);

    // 0. 设置父容器宽高
    if (typeof document !== "undefined") {
      const levelBoardDom: any =
        document.getElementsByClassName("level-board")[0];
      if (levelBoardDom) {
        levelBoardDom.style.width = widthUnit * boxWidthNum + "px";
        levelBoardDom.style.height = heightUnit * boxHeightNum + "px";
      }
    }

    // 1. 规划块数
    // 块数单位（总块数必须是该值的倍数）
    const blockNumUnit = config.composeNum * config.typeNum;
    console.log("块数单位", blockNumUnit);

    // 随机生成的总块数
    const totalRandomBlockNum = config.randomBlocks.reduce(
      (pre: number, curr: number) => {
        return pre + curr;
      },
      0
    );
    console.log("随机生成的总块数", totalRandomBlockNum);

    // 需要的最小块数
    const minBlockNum =
      config.levelNum * config.levelBlockNum + totalRandomBlockNum;
    console.log("需要的最小块数", minBlockNum);

    // 补齐到 blockNumUnit 的倍数
    // e.g. minBlockNum = 14, blockNumUnit = 6, 补到 18
    totalBlockNum.value = minBlockNum;
    if (blockNumUnit > 0 && totalBlockNum.value % blockNumUnit !== 0) {
      totalBlockNum.value =
        (Math.floor(minBlockNum / blockNumUnit) + 1) * blockNumUnit;
    }
    console.log("总块数", totalBlockNum.value);

    // 2. 初始化块，随机生成块的内容
    // 保存所有块的数组（新局使用新数组，避免上一局残留）
    allBlocks = [];
    // 需要用到的动物数组
    const needAnimals = config.animals.slice(0, config.typeNum);
    // 依次把块塞到数组里
    const animalBlocks: string[] = [];
    for (let i = 0; i < totalBlockNum.value; i++) {
      animalBlocks.push(needAnimals[i % config.typeNum]);
    }
    // 打乱数组
    const randomAnimalBlocks = _.shuffle(animalBlocks);

    // 初始化
    // 使用 reactive 包装：棋盘、层级区、槽位共享同一块对象实例，
    // 任何一处的 status / type / 遮挡关系变化都能同步到视图。
    for (let i = 0; i < totalBlockNum.value; i++) {
      const newBlock = reactive({
        id: i,
        x: 0,
        y: 0,
        status: 0,
        level: 0,
        type: randomAnimalBlocks[i],
        higherThanBlocks: [] as BlockType[],
        lowerThanBlocks: [] as BlockType[],
      }) as BlockType;
      allBlocks.push(newBlock);
    }

    // 下一个要塞入的块
    let pos = 0;

    // 3. 计算随机生成的块
    const randomBlocks: BlockType[][] = [];
    config.randomBlocks.forEach((randomBlock: number, idx: number) => {
      randomBlocks[idx] = [];
      for (let i = 0; i < randomBlock; i++) {
        randomBlocks[idx].push(allBlocks[pos]);
        pos++;
      }
    });

    // 剩余块数
    let leftBlockNum = totalBlockNum.value - totalRandomBlockNum;

    // 4. 计算有层级关系的块
    const levelBlocks: BlockType[] = [];
    let minX = 0;
    let maxX = 22;
    let minY = 0;
    let maxY = 22;
    // 分为 config.levelNum 批，依次生成，每批的边界不同
    for (let i = 0; i < config.levelNum; i++) {
      let nextBlockNum = Math.min(config.levelBlockNum, leftBlockNum);
      // 最后一批，分配所有 leftBlockNum
      if (i === config.levelNum - 1) {
        nextBlockNum = leftBlockNum;
      }
      // 边界收缩
      if (config.borderStep > 0) {
        const dir = i % 4;
        if (i > 0) {
          if (dir === 0) {
            minX += config.borderStep;
          } else if (dir === 1) {
            maxY -= config.borderStep;
          } else if (dir === 2) {
            minY += config.borderStep;
          } else {
            maxX -= config.borderStep;
          }
        }
      }
      const nextGenBlocks = allBlocks.slice(pos, pos + nextBlockNum);
      levelBlocks.push(...nextGenBlocks);
      pos = pos + nextBlockNum;
      // 生成块的坐标
      genLevelBlockPos(nextGenBlocks, minX, minY, maxX, maxY);
      leftBlockNum -= nextBlockNum;
      if (leftBlockNum <= 0) {
        break;
      }
    }
    console.log("最终剩余块数", leftBlockNum);

    // 5. 依据最终棋盘状态统一重建遮挡关系，避免生成过程中的遗漏
    rebuildLevelRelations();

    // 6. 初始化空插槽
    const slotArea: Array<BlockType | null> = new Array(config.slotNum).fill(
      null
    );
    console.log("随机块情况", randomBlocks);

    return {
      levelBlocks,
      randomBlocks,
      slotArea,
    };
  };

  /**
   * 生成一批层级块（坐标、层级关系）
   */
  const genLevelBlockPos = (
    blocks: BlockType[],
    minX: number,
    minY: number,
    maxX: number,
    maxY: number
  ) => {
    // 记录这批块的坐标，用于保证同批次元素不能完全重叠
    const currentPosSet = new Set<string>();
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      // 随机生成坐标
      let newPosX;
      let newPosY;
      let key;
      while (true) {
        newPosX = Math.floor(Math.random() * maxX + minX);
        newPosY = Math.floor(Math.random() * maxY + minY);
        key = newPosX + "," + newPosY;
        // 同批次元素不能完全重叠
        if (!currentPosSet.has(key)) {
          break;
        }
      }
      chessBoard[newPosX][newPosY].blocks.push(block);
      currentPosSet.add(key);
      block.x = newPosX;
      block.y = newPosY;
      // 填充层级关系（用于确定层级 level）
      genLevelRelation(block);
    }
  };

  /**
   * 给块绑定层级关系（用于确认哪些元素是当前可点击的）
   * 核心逻辑：每个块压住和其坐标有交集棋盘格内所有 level 大于它的点，双向建立联系
   */
  const genLevelRelation = (block: BlockType) => {
    // 确定该块附近的格子坐标范围
    const minX = Math.max(block.x - 2, 0);
    const minY = Math.max(block.y - 2, 0);
    const maxX = Math.min(block.x + 3, boxWidthNum - 2);
    const maxY = Math.min(block.y + 3, boxHeightNum - 2);
    // 遍历该块附近的格子
    let maxLevel = 0;
    for (let i = minX; i < maxX; i++) {
      for (let j = minY; j < maxY; j++) {
        const relationBlocks = chessBoard[i][j].blocks;
        if (relationBlocks.length > 0) {
          // 取当前位置最高层的块
          const maxLevelRelationBlock =
            relationBlocks[relationBlocks.length - 1];
          // 排除自己
          if (maxLevelRelationBlock.id === block.id) {
            continue;
          }
          maxLevel = Math.max(maxLevel, maxLevelRelationBlock.level);
          block.higherThanBlocks.push(maxLevelRelationBlock);
          maxLevelRelationBlock.lowerThanBlocks.push(block);
        }
      }
    }
    // 比最高层的块再高一层（初始为 1）
    block.level = maxLevel + 1;
  };

  /**
   * 点击块事件
   *
   * @param block 被点击的块
   * @param randomIdx 随机区域下标，>= 0 表示点击的是随机块
   * @param force 强制移除（技能）
   */
  const doClickBlock = (block: BlockType, randomIdx = -1, force = false) => {
    const config = getGameConfig();
    // 对局未进行 / 槽位已满 / 已被点击 / 有上层块（且非强制和圣光），都不能点击
    if (
      gameStatus.value !== 1 ||
      currSlotNum.value >= config.slotNum ||
      block.status !== 0 ||
      (block.lowerThanBlocks.length > 0 && !force && !isHolyLight.value)
    ) {
      return;
    }
    isHolyLight.value = false;
    // 修改元素状态为已点击
    block.status = 1;
    if (randomIdx >= 0) {
      // 移除所点击的随机区域中的该元素
      randomBlocksVal.value[randomIdx] = randomBlocksVal.value[
        randomIdx
      ].filter((randomBlock) => randomBlock.id !== block.id);
    } else {
      // 非随机区才可撤回
      opHistory.value = [...opHistory.value, block];
      // 从棋盘移除，并重建遮挡关系（解锁下方块）
      removeBlockFromBoard(block);
      rebuildLevelRelations();
    }
    // 新元素加入插槽
    const slotBlocks = [...getSlotBlocks(), block];
    commitSlot(slotBlocks);
    // 检查是否有可消除的
    // block => 出现次数
    const map: Record<string, number> = {};
    slotBlocks.forEach((slotBlock) => {
      const type = slotBlock.type;
      if (!map[type]) {
        map[type] = 1;
      } else {
        map[type]++;
      }
    });
    const remainBlocks: BlockType[] = [];
    let clearNum = 0;
    slotBlocks.forEach((slotBlock) => {
      // 成功消除（不保留在槽位中）
      if (map[slotBlock.type] >= config.composeNum) {
        // 块状态改为已消除
        slotBlock.status = 2;
        clearNum++;
        return;
      }
      remainBlocks.push(slotBlock);
    });
    if (clearNum > 0) {
      // 已消除块数累加
      clearBlockNum.value += clearNum;
      // 清除操作记录，防止撤回
      opHistory.value = [];
    }
    commitSlot(remainBlocks);
    // 游戏结束
    if (currSlotNum.value >= config.slotNum) {
      gameStatus.value = 2;
      if (typeof window !== "undefined") {
        clearLoseTimer();
        loseTimer = setTimeout(() => {
          loseTimer = null;
          window.alert("你输了");
        }, 2000);
      }
    }
    if (clearBlockNum.value >= totalBlockNum.value) {
      gameStatus.value = 3;
    }
  };

  /**
   * 开始游戏（每次调用都会完整重置上一局状态）
   */
  const doStart = () => {
    resetGame();
    const { levelBlocks, randomBlocks, slotArea } = initGame();
    levelBlocksVal.value = levelBlocks;
    randomBlocksVal.value = randomBlocks;
    slotAreaVal.value = slotArea;
    currSlotNum.value = 0;
    gameStatus.value = 1;
  };

  // region 技能

  /**
   * 洗牌
   *
   * @desc 只随机重洗所有未被点击块的图案，不改变块位置与遮挡关系
   */
  const doShuffle = () => {
    // 遍历所有未消除、未点击的块
    const originBlocks = allBlocks.filter((block) => block.status === 0);
    const newBlockTypes = _.shuffle(originBlocks.map((block) => block.type));
    let pos = 0;
    originBlocks.forEach((block) => {
      block.type = newBlockTypes[pos++];
    });
    // 触发层级区与随机区刷新，遮挡关系保持不变
    levelBlocksVal.value = [...levelBlocksVal.value];
    randomBlocksVal.value = [...randomBlocksVal.value];
  };

  /**
   * 破坏
   *
   * @desc 消除一组层级块
   */
  const doBroke = () => {
    const config = getGameConfig();
    // 类型，块列表映射
    const typeBlockMap: Record<string, BlockType[]> = {};
    const blocks = levelBlocksVal.value.filter((block) => block.status === 0);
    // 遍历所有未消除的层级块
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!typeBlockMap[block.type]) {
        typeBlockMap[block.type] = [];
      }
      typeBlockMap[block.type].push(block);
      // 有能消除的一组块
      if (typeBlockMap[block.type].length >= config.composeNum) {
        typeBlockMap[block.type].forEach((clickBlock) => {
          doClickBlock(clickBlock, -1, true);
        });
        break;
      }
    }
  };

  /**
   * 撤回
   *
   * @desc 把最近点击的块从槽位恢复到棋盘原位，并重建遮挡关系、修正槽占用数
   */
  const doRevert = () => {
    if (opHistory.value.length < 1) {
      return;
    }
    const block = opHistory.value[opHistory.value.length - 1];
    const slotBlocks = getSlotBlocks();
    if (!slotBlocks.some((slotBlock) => slotBlock.id === block.id)) {
      // 槽位中已不存在该块（数据异常），仅移除历史，避免状态继续错乱
      opHistory.value = opHistory.value.slice(0, -1);
      return;
    }
    // 移出历史
    opHistory.value = opHistory.value.slice(0, -1);
    // 从槽位移除，并同步占用数
    commitSlot(slotBlocks.filter((slotBlock) => slotBlock.id !== block.id));
    // 恢复到棋盘原位，并重新参与遮挡判定
    block.status = 0;
    addBlockToBoard(block);
    rebuildLevelRelations();
    if (gameStatus.value === 2) {
      clearLoseTimer();
      gameStatus.value = 1;
    }
  };

  /**
   * 移出块
   *
   * @desc 把槽位首块放回层级区（棋盘），并让它重新参与遮挡判定
   */
  const doRemove = () => {
    const slotBlocks = getSlotBlocks();
    const block = slotBlocks[0];
    if (!block) {
      return;
    }
    // 槽位移除首块，并同步占用数
    commitSlot(slotBlocks.slice(1));
    // 该块不再可撤回
    opHistory.value = opHistory.value.filter(
      (historyBlock) => historyBlock.id !== block.id
    );
    block.status = 0;
    // 放到棋盘底部的层级区（保证坐标 + 3 不越界）
    block.x = Math.floor(Math.random() * (boxWidthNum - BLOCK_SIZE + 1));
    block.y = boxHeightNum - BLOCK_SIZE;
    // 随机块需要补进层级区渲染列表
    if (
      !levelBlocksVal.value.some((levelBlock) => levelBlock.id === block.id)
    ) {
      levelBlocksVal.value.push(block);
    }
    // 放回棋盘
    addBlockToBoard(block);
    // 层级取当前重叠块的最大层级 + 1，保证它能被正常点击
    const maxLevel = getBoardBlocks()
      .filter(
        (boardBlock) =>
          boardBlock.id !== block.id && isOverlap(boardBlock, block)
      )
      .reduce((max, boardBlock) => Math.max(max, boardBlock.level), 0);
    block.level = maxLevel + 1;
    rebuildLevelRelations();
    if (gameStatus.value === 2) {
      clearLoseTimer();
      gameStatus.value = 1;
    }
  };

  /**
   * 圣光
   *
   * @desc 下一个块可以任意点击
   */
  const doHolyLight = () => {
    isHolyLight.value = true;
  };

  /**
   * 透视
   *
   * @desc 可以看到随机块
   */
  const doSeeRandom = () => {
    canSeeRandom.value = !canSeeRandom.value;
  };

  // endregion

  return {
    gameStatus,
    levelBlocksVal,
    randomBlocksVal,
    slotAreaVal,
    widthUnit,
    heightUnit,
    currSlotNum,
    opHistory,
    totalBlockNum,
    clearBlockNum,
    isHolyLight,
    canSeeRandom,
    doClickBlock,
    doStart,
    resetGame,
    doShuffle,
    doBroke,
    doRemove,
    doRevert,
    doHolyLight,
    doSeeRandom,
    // 供调试 / 自动化测试使用
    getBoardBlocks,
  };
};

export default useGame;
