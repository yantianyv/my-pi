/**
 * hud：3 行 HUD 状态栏（多文件扩展入口，pi 加载约定）
 *
 * 本文件只是 pi 扩展加载入口（目录模式要求 index.ts），核心实现见 hud-core.ts：
 *   hud-core.ts     核心：渲染 + 生命周期 + 命令
 *   hud-balance.ts  供应商余额适配层
 *   hud-cost.ts     消耗统计与成本换算
 *   hud-git.ts      git 状态解析
 *
 * 子模块可选加载：缺失时对应功能降级显示（详见 hud-core.ts 头部注释）。
 */
export { default } from "./hud-core";
