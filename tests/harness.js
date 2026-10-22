'use strict';

/**
 * 前端测试的共用夹具：把页面脚本丢进 vm 里跑，模拟浏览器全局。
 * ui.test.js 和 playthrough.js 都用它，避免两份 stub 飘掉。
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function fakeEl() {
  return {
    innerHTML: '',
    value: '',
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] || (this.listeners[type] = [])).push(fn);
    },
    appendChild() {},
    setAttribute() {},
    getAttribute() {
      return null;
    },
    classList: { add() {}, remove() {}, toggle() {} },
    style: { setProperty() {} },
    querySelectorAll() {
      return [];
    },
    remove() {},
    closest() {
      return null;
    },
  };
}

function loadPage(file) {
  const el = fakeEl();
  const sandbox = {
    console,
    location: { search: '', origin: 'http://192.168.1.5:3000', host: '192.168.1.5:3000', protocol: 'http:' },
    navigator: {},
    innerHeight: 900,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    WebSocket: function () {
      this.addEventListener = () => {};
      this.send = () => {};
      this.close = () => {};
    },
    document: {
      documentElement: { style: { setProperty() {} } },
      getElementById: () => el,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => fakeEl(),
      body: { appendChild() {} },
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.addEventListener = () => {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // 浏览器里两个 <script> 共享作用域，这里照做
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/common.js'), 'utf8'), sandbox, {
    filename: 'common.js',
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  return sandbox;
}

/** 给页面塞角色表（真实环境是服务端在 welcome 里下发的） */
function setRoles(page, roles) {
  vm.runInContext(`P.roles = ${JSON.stringify(roles)};`, page);
}

/** 和 server.js 里那份一致：角色表数据 */
function roleChoices() {
  const { ROLES, TYPE_LABEL } = require('../engine/roles');
  return Object.values(ROLES).map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    typeLabel: TYPE_LABEL[r.type],
    brief: r.brief,
  }));
}

module.exports = { loadPage, setRoles, roleChoices, fakeEl };
