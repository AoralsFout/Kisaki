# 依赖风险记录

审查日期：2026-08-27  
下次强制复审：2026-09-30，或任一相关依赖更新时

## npm audit 当前结果

`npm audit --omit=dev` 当前报告 10 个 high、5 个 moderate，暂无自动修复版本：

- `brace-expansion` 经 `easy-live2d -> eslint` 的工具链依赖进入树中。Kisaki 不在运行时调用 glob 展开接口，且打包产物不包含 eslint CLI；当前判断为成品不可达。
- `nanoid` 经 `vue -> @vue/compiler-sfc -> postcss` 进入构建依赖路径。`.vue` 文件在构建期预编译，成品不调用相关自定义随机生成器；当前判断为成品不可达。

以上不是永久豁免。Dependabot 每周检查 npm/Cargo 依赖；一旦上游提供修复，应升级并删除本记录。CI 对新增 critical 漏洞直接失败。

## 发布前复审方法

1. 执行 `npm audit --omit=dev` 并保存结果。
2. 确认漏洞代码是否被打入 `dist` 或能由不可信输入触达。
3. 执行 RustSec 审计并处理所有可达漏洞。
4. 若继续接受风险，记录 advisory、调用路径、不可达证据、负责人和新的复审日期。

