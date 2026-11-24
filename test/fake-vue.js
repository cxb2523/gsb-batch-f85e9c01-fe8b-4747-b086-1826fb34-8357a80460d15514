'use strict'
/*
 * 最小 Vue 2 运行时 shim，仅实现 canvasPlayer 组件与 index.js 入口用到的能力：
 * data 合并、methods 绑定、mounted/beforeDestroy 钩子、$nextTick、$destroy、
 * $on/$emit/$once、Vue.extend、Vue.prototype。
 */

function nextTick(cb) {
  // 测试里直接同步执行，保证时序确定可控
  cb.call(this)
}

function buildVm(Options, dataOverride) {
  const opts = Options.options || Options
  const dataObj = typeof opts.data === 'function' ? opts.data() : Object.assign({}, opts.data)
  // 兼容 new Ctor({ data: {...} })（index.js 的真实调用形态）与 new Ctor({...}) 两种传参
  const override = dataOverride && Object.prototype.hasOwnProperty.call(dataOverride, 'data') && Object.keys(dataOverride).length === 1
    ? dataOverride.data
    : dataOverride
  if (override) Object.assign(dataObj, override)

  const vm = {
    _opts: opts,
    _listeners: Object.create(null),
    $el: null,
    destroyed: false,
  }
  Object.assign(vm, dataObj)

  // methods 绑定到 vm
  for (const key of Object.keys(opts.methods || {})) {
    vm[key] = opts.methods[key].bind(vm)
  }

  vm.$nextTick = function(cb) {
    if (typeof cb === 'function') nextTick.call(vm, cb)
  }
  vm.$on = function(event, fn) {
    if (!vm._listeners[event]) vm._listeners[event] = []
    vm._listeners[event].push(fn)
    return vm
  }
  vm.$once = function(event, fn) {
    const wrapped = (...args) => {
      vm.$off(event, wrapped)
      fn(...args)
    }
    return vm.$on(event, wrapped)
  }
  vm.$off = function(event, fn) {
    if (!vm._listeners[event]) return vm
    if (!fn) {
      vm._listeners[event] = []
    } else {
      const i = vm._listeners[event].indexOf(fn)
      if (i >= 0) vm._listeners[event].splice(i, 1)
    }
    return vm
  }
  vm.$emit = function(event, ...args) {
    for (const fn of (vm._listeners[event] || []).slice()) fn(...args)
    return vm
  }
  vm.$destroy = function() {
    if (vm.destroyed) return
    vm.destroyed = true
    // 与 Vue 一致：先派发 hook 事件（index.js 用 $once 监听 hook:beforeDestroy），再执行组件自身钩子
    vm.$emit('hook:beforeDestroy')
    if (typeof opts.beforeDestroy === 'function') opts.beforeDestroy.call(vm)
  }
  vm.$mount = function() {
    // 不做真实模板编译，给一个可挂载/移除的根节点
    if (!vm.$el) {
      const el = document.createElement('div')
      el.className = 'popup-layer'
      el._vm = vm
      vm.$el = el
    }
    if (typeof opts.mounted === 'function') opts.mounted.call(vm)
    return vm
  }
  return vm
}

function FakeVue() {}
FakeVue.extend = function(opts) {
  const Sub = function(dataOverride) {
    return buildVm(opts, dataOverride)
  }
  Sub.options = opts
  Sub.extend = (more) => FakeVue.extend(Object.assign({}, opts, more))
  return Sub
}
FakeVue.prototype.$isServer = false

module.exports = { FakeVue, buildVm }
