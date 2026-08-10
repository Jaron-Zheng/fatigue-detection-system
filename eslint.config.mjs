/**
 * eslint.config.mjs — 第三轮角色三引入（flat config）
 *
 * 规则取向：不激进，只约束真正容易出 bug 的几类——
 * `==` 误用、未使用变量、NaN 比较、不可达代码、常量条件等。
 * 风格类问题交给 Prettier（见 .prettierrc.json），ESLint 不重复管辖。
 *
 * 仅开发者工具链：需要先执行一次 `npm install`，
 * 与「npm start 零安装运行」互不影响。
 */
import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: [
      'node_modules/**',
      'web/vendor/**',
      'system-delivery/**',
      'docs-evidence/**',
      '*.bat',
    ],
  },
  js.configs.recommended,
  {
    files: ['web/js/**/*.js', 'tools/**/*.mjs', 'tools/**/*.js', 'server/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // == 误用：除与 null 比较外一律要求 ===
      eqeqeq: ['error', 'smart'],
      // NaN 比较与负零等数值陷阱
      'no-compare-neg-zero': 'error',
      // 未使用变量：报 warning（参数不查，_ 前缀豁免）
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      // 恒定条件 / 不可达 / 自比较（x === x 常用于 NaN 检测，豁免）
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-unreachable': 'error',
      'no-self-compare': 'off',
      // 项目中存在合理的异步 Promise 构造器用法（事件桥接）
      'no-async-promise-executor': 'off',
      // 误改常量与可疑覆盖
      'no-const-assign': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-keys': 'error',
      // debugger/console 在本地工具型项目中是合理手段，不报错
      'no-console': 'off',
      'no-debugger': 'warn',
    },
  },
  // 关闭与 Prettier 冲突的规则（必须放最后）
  prettier,
];
