/*
 * @description: canvas 混剪播放器入口
 */
import Vue from "vue";
import Play from "./canvasPlayer.vue";
import videoObj from "./data";
let Player = Vue.extend(Play);
let instance;
let seed = 1;

const component = (options) => {
  if (Vue.prototype.$isServer || seed !== 1) return;
  // 兼容 $canvasVideoPlayer(list) 数组入参与 $canvasVideoPlayer({ list, logo, ... }) 对象入参
  if (Array.isArray(options)) {
    options = { list: options };
  } else if (!options || !options.list) {
    options = videoObj;
  }
  instance = new Player({
    data: options,
  });
  instance.id = "player_" + seed++;
  instance.vm = instance.$mount();
  instance.dom = instance.vm.$el;
  document.body.appendChild(instance.dom);
  instance.vm.init();
  instance.dom.style.zIndex = seed + 1001;
  seed = 2;
  // 组件自身的 setFree 负责释放 rAF / 定时器 / 节点，这里只在销毁后恢复单例开关
  instance.vm.$once("hook:beforeDestroy", () => {
    seed = 1;
  });
  return instance.vm;
};

export default {
  install: (Vue) => {
    Vue.prototype.$canvasVideoPlayer = component;
  },
};
