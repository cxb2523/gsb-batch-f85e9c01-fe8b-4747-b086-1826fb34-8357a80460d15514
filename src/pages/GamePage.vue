<template>
  <div id="gamePage">
    <a-row align="space-between">
      <div>
        <a-button style="margin-bottom: 8px" data-action="back" @click="doBack">
          返回
        </a-button>
        <a-button
          style="margin-bottom: 8px; margin-left: 8px"
          data-action="restart"
          @click="doRestart"
        >
          重新开始
        </a-button>
      </div>
      <a-button>
        块数：{{ clearBlockNum }} / {{ totalBlockNum }}，槽位：{{ currSlotNum }}
      </a-button>
    </a-row>
    <!-- 胜利 -->
    <a-row align="center">
      <div v-if="gameStatus === 3" style="text-align: center">
        <h2>恭喜，你赢啦！🎉</h2>
        <img alt="程序员鱼皮" src="../assets/kunkun.png" />
        <my-ad style="margin-top: 16px" />
      </div>
    </a-row>
    <!-- 分层选块 -->
    <a-row align="center">
      <div v-show="gameStatus > 0" class="level-board">
        <div v-for="(block, idx) in levelBlocksVal" :key="idx">
          <div
            v-if="block.status === 0"
            class="block level-block"
            :class="{
              disabled: !isHolyLight && block.lowerThanBlocks.length > 0,
            }"
            :data-id="block.id"
            :style="{
              zIndex: 100 + block.level,
              left: block.x * widthUnit + 'px',
              top: block.y * heightUnit + 'px',
            }"
            @click="() => doClickBlock(block)"
          >
            {{ block.type }}
          </div>
        </div>
      </div>
    </a-row>
    <!-- 随机选块 -->
    <a-row align="space-between" class="random-board">
      <div
        v-for="(randomBlock, index) in randomBlocksVal"
        :key="index"
        class="random-area"
      >
        <div
          v-if="randomBlock.length > 0"
          :data-id="randomBlock[0].id"
          class="block"
          @click="() => doClickBlock(randomBlock[0], index)"
        >
          {{ randomBlock[0].type }}
        </div>
        <!-- 隐藏 -->
        <div
          v-for="num in Math.max(randomBlock.length - 1, 0)"
          :key="num"
          class="block disabled"
        >
          <span v-if="canSeeRandom">
            {{ randomBlock[num].type }}
          </span>
        </div>
      </div>
    </a-row>
    <!-- 槽位 -->
    <a-row v-if="slotAreaVal.length > 0" align="center" class="slot-board">
      <div v-for="(slotBlock, index) in slotAreaVal" :key="index" class="block">
        {{ slotBlock?.type }}
      </div>
    </a-row>
    <!-- 技能 -->
    <div class="skill-board">
      <a-space>
        <a-button size="small" data-skill="revert" @click="doRevert">
          撤回
        </a-button>
        <a-button size="small" data-skill="remove" @click="doRemove">
          移出
        </a-button>
        <a-button size="small" data-skill="shuffle" @click="doShuffle">
          洗牌
        </a-button>
        <a-button size="small" data-skill="broke" @click="doBroke">
          破坏
        </a-button>
        <a-button size="small" data-skill="holy-light" @click="doHolyLight">
          圣光
        </a-button>
        <a-button size="small" data-skill="see-random" @click="doSeeRandom">
          透视
        </a-button>
      </a-space>
    </div>
  </div>
</template>

<script setup lang="ts">
import useGame from "../core/game";
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import MyAd from "../components/MyAd.vue";

const router = useRouter();

const {
  gameStatus,
  levelBlocksVal,
  randomBlocksVal,
  slotAreaVal,
  widthUnit,
  heightUnit,
  totalBlockNum,
  clearBlockNum,
  currSlotNum,
  opHistory,
  isHolyLight,
  canSeeRandom,
  doClickBlock,
  doStart,
  doShuffle,
  doBroke,
  doRemove,
  doRevert,
  doHolyLight,
  doSeeRandom,
  getBoardBlocks,
} = useGame();

// 仅开发环境暴露游戏实例，便于浏览器端自动化 / 调试校验
// 生产构建时 import.meta.env.DEV 为 false，该分支会被剔除
if (import.meta.env.DEV) {
  (window as any).__game = {
    gameStatus,
    levelBlocksVal,
    randomBlocksVal,
    slotAreaVal,
    totalBlockNum,
    clearBlockNum,
    currSlotNum,
    isHolyLight,
    canSeeRandom,
    opHistory,
    getBoardBlocks,
    doClickBlock,
    doShuffle,
    doBroke,
    doRemove,
    doRevert,
    doHolyLight,
    doSeeRandom,
  };
}

/**
 * 回上一页
 */
const doBack = () => {
  router.back();
};

/**
 * 重新开始一局（完整清空上一局状态后重新生成）
 */
const doRestart = () => {
  doStart();
};

onMounted(() => {
  doStart();
});
</script>

<style scoped>
.level-board {
  position: relative;
}

.level-block {
  position: absolute;
}

.random-board {
  margin-top: 8px;
}

.random-area {
  margin-top: 8px;
}

.slot-board {
  border: 10px solid saddlebrown;
  margin: 16px auto;
  width: fit-content;
}

.skill-board {
  text-align: center;
}

.block {
  font-size: 28px;
  width: 42px;
  height: 42px;
  line-height: 42px;
  border: 1px solid #eee;
  background: white;
  text-align: center;
  vertical-align: top;
  display: inline-block;
}

.disabled {
  background: grey;
  cursor: not-allowed;
}
</style>
